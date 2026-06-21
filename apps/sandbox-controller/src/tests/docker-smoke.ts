import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BuildRunner } from "../buildRunner.js";
import { CleanupManager } from "../cleanup.js";
import { ContainerRunner } from "../containerRunner.js";
import { DependencyResolver } from "../dependencyResolver.js";
import { DependencyServiceManager } from "../dependencyServices.js";
import { discoverExecutionManifest } from "../executionManifest.js";
import { RuntimeLifecycleManager } from "../runtimeLifecycle.js";
import { SandboxManager, WorkspaceManifest } from "../sandbox.js";
import { ServiceStartupManager } from "../serviceStartup.js";
import { TestRunner } from "../testRunner.js";

async function runDockerSmoke() {
  const sandboxId = `smoke-${crypto.randomUUID().slice(0, 8)}`;
  const runner = new ContainerRunner();
  const dependencies = new DependencyServiceManager(true, runner);
  let network = "";
  let applicationContainerId = "";

  try {
    await runner.cleanupSandboxResources(sandboxId);
    network = await runner.createNetwork(sandboxId);

    const provisioned = await dependencies.provision(sandboxId, network, [
      { type: "postgresql", required: true, evidence: ["smoke-test"] },
      { type: "redis", required: true, evidence: ["smoke-test"] }
    ]);
    assert.strictEqual(provisioned.success, true, provisioned.log);
    assert.match(provisioned.environment.DATABASE_URL, /@postgres:5432\/app$/);
    assert.strictEqual(provisioned.environment.REDIS_URL, "redis://redis:6379");

    const application = await runner.startDetached({
      sandboxId,
      network,
      networkAliases: ["application"],
      ports: [3000],
      command: [
        "node",
        "-e",
        "require('http').createServer((_,res)=>res.end('opspilot-smoke-ok')).listen(3000,'0.0.0.0')"
      ]
    });
    assert.strictEqual(application.success, true, application.log);
    assert.ok(application.containerId);
    applicationContainerId = application.containerId!;
    assert.strictEqual(application.portBindings.length, 1);
    assert.notStrictEqual(application.portBindings[0].hostPort, 3000);
    assert.match(application.portBindings[0].externalUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

    let body = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        body = await fetch(application.portBindings[0].externalUrl).then((response) => response.text());
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    assert.strictEqual(body, "opspilot-smoke-ok");
    console.log(JSON.stringify({
      success: true,
      network,
      endpoint: application.portBindings[0],
      dependencies: provisioned.services.map((service) => service.type)
    }, null, 2));
  } finally {
    if (applicationContainerId) await runner.stop(applicationContainerId).catch(() => undefined);
    await dependencies.stopAll(sandboxId);
    await runner.cleanupSandboxResources(sandboxId);
  }

  await runLifecycleSmoke(runner);
  await runMultiServiceLifecycleSmoke(runner);
}

async function runLifecycleSmoke(runner: ContainerRunner) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opspilot-lifecycle-smoke-"));
  const sandboxId = `lifecycle-${crypto.randomUUID().slice(0, 8)}`;
  const workspaceDir = path.join(root, sandboxId);
  const repositoryRoot = path.join(workspaceDir, "repository");
  await fs.promises.mkdir(repositoryRoot, { recursive: true });

  await fs.promises.writeFile(path.join(repositoryRoot, "package.json"), JSON.stringify({
    name: "opspilot-lifecycle-smoke",
    version: "1.0.0",
    scripts: {
      build: "node -e \"require('fs').writeFileSync('build-output.txt','ok')\"",
      start: "node server.js",
      test: "node test.js"
    }
  }));
  await fs.promises.writeFile(path.join(repositoryRoot, "package-lock.json"), JSON.stringify({
    name: "opspilot-lifecycle-smoke",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "opspilot-lifecycle-smoke", version: "1.0.0" }
    }
  }));
  await fs.promises.writeFile(
    path.join(repositoryRoot, "server.js"),
    "require('http').createServer((_,res)=>res.end('lifecycle-ok')).listen(3000,'0.0.0.0');"
  );
  await fs.promises.writeFile(
    path.join(repositoryRoot, "test.js"),
    "fetch('http://127.0.0.1:3000').then(r=>r.text()).then(v=>{if(v!=='lifecycle-ok')process.exit(1)}).catch(()=>process.exit(1));"
  );

  const execution = await discoverExecutionManifest(repositoryRoot);
  execution.services = [
    { type: "postgresql", required: true, evidence: ["smoke-test"] },
    { type: "redis", required: true, evidence: ["smoke-test"] }
  ];
  const workspaceManifest: WorkspaceManifest = {
    sandboxId,
    snapshotId: "smoke-snapshot",
    commitSha: "smoke-commit",
    repositoryRoot,
    createdAt: new Date().toISOString(),
    verifiedFileCount: 0,
    execution
  };
  await fs.promises.writeFile(
    path.join(workspaceDir, "opspilot-workspace.json"),
    JSON.stringify(workspaceManifest)
  );

  const sandboxManager = new SandboxManager({ baseDir: root, persistSandbox: false });
  const dependencyServices = new DependencyServiceManager(true, runner);
  const serviceStartup = new ServiceStartupManager(true, runner);
  const lifecycle = new RuntimeLifecycleManager(
    sandboxManager,
    new DependencyResolver(true, runner),
    new BuildRunner(true, runner),
    dependencyServices,
    serviceStartup,
    new TestRunner(true, runner),
    runner
  );

  try {
    const result = await lifecycle.run(sandboxId);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, "RUNTIME_VERIFIED");
    assert.ok(result.stages.some((stage) => stage.stage === "build" && stage.success));
    assert.ok(result.tests.some((test) => test.type === "unit" && test.success));
    assert.notStrictEqual(result.endpoints[0].hostPort, 3000);
    console.log(JSON.stringify({
      lifecycle: "verified",
      status: result.status,
      endpoint: result.endpoints[0],
      stages: result.stages.map((stage) => ({ stage: stage.stage, success: stage.success }))
    }, null, 2));
  } finally {
    await lifecycle.cleanupRuntime(sandboxId);
    await runner.run({
      sandboxId: `${sandboxId}-workspace-cleanup`,
      workspaceDir: repositoryRoot,
      command: ["rm", "-rf", "node_modules"],
      user: null
    }).catch(() => undefined);
    await new CleanupManager().deleteWorkspaceDir(root);
  }
}

async function runMultiServiceLifecycleSmoke(runner: ContainerRunner) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opspilot-multi-smoke-"));
  const sandboxId = `multi-${crypto.randomUUID().slice(0, 8)}`;
  const workspaceDir = path.join(root, sandboxId);
  const repositoryRoot = path.join(workspaceDir, "repository");
  for (const service of ["api", "worker", "web"]) {
    await fs.promises.mkdir(path.join(repositoryRoot, "apps", service), { recursive: true });
  }

  await fs.promises.writeFile(path.join(repositoryRoot, "package.json"), JSON.stringify({
    name: "opspilot-multi-smoke",
    version: "1.0.0",
    private: true,
    workspaces: ["apps/*"]
  }));
  await fs.promises.writeFile(path.join(repositoryRoot, "package-lock.json"), JSON.stringify({
    name: "opspilot-multi-smoke",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "opspilot-multi-smoke",
        version: "1.0.0",
        workspaces: ["apps/*"]
      },
      "apps/api": { name: "@smoke/api", version: "1.0.0" },
      "apps/worker": { name: "@smoke/worker", version: "1.0.0" },
      "apps/web": { name: "@smoke/web", version: "1.0.0" },
      "node_modules/@smoke/api": { resolved: "apps/api", link: true },
      "node_modules/@smoke/worker": { resolved: "apps/worker", link: true },
      "node_modules/@smoke/web": { resolved: "apps/web", link: true }
    }
  }));
  await fs.promises.writeFile(path.join(repositoryRoot, "apps", "api", "package.json"), JSON.stringify({
    name: "@smoke/api",
    version: "1.0.0",
    scripts: { start: "node server.js", test: "node test.js" }
  }));
  await fs.promises.writeFile(
    path.join(repositoryRoot, "apps", "api", "server.js"),
    "require('http').createServer((_,res)=>res.end('api-ok')).listen(Number(process.env.PORT||4100),'0.0.0.0');"
  );
  await fs.promises.writeFile(
    path.join(repositoryRoot, "apps", "api", "test.js"),
    "fetch(`http://127.0.0.1:${process.env.PORT}`).then(r=>r.text()).then(v=>{if(v!=='api-ok')process.exit(1)}).catch(()=>process.exit(1));"
  );
  await fs.promises.writeFile(path.join(repositoryRoot, "apps", "worker", "package.json"), JSON.stringify({
    name: "@smoke/worker",
    version: "1.0.0",
    scripts: { start: "node worker.js" }
  }));
  await fs.promises.writeFile(
    path.join(repositoryRoot, "apps", "worker", "worker.js"),
    "console.log('worker-ready'); setInterval(()=>{},1000);"
  );
  await fs.promises.writeFile(path.join(repositoryRoot, "apps", "web", "package.json"), JSON.stringify({
    name: "@smoke/web",
    version: "1.0.0",
    scripts: { start: "node server.js" }
  }));
  await fs.promises.writeFile(
    path.join(repositoryRoot, "apps", "web", "server.js"),
    "require('http').createServer((_,res)=>res.end(process.env.API_URL?'web-ok':'missing-api')).listen(Number(process.env.PORT||3000),'0.0.0.0');"
  );

  const execution = await discoverExecutionManifest(repositoryRoot);
  const workspaceManifest: WorkspaceManifest = {
    sandboxId,
    snapshotId: "multi-smoke-snapshot",
    commitSha: "multi-smoke-commit",
    repositoryRoot,
    createdAt: new Date().toISOString(),
    verifiedFileCount: 0,
    execution
  };
  await fs.promises.writeFile(
    path.join(workspaceDir, "opspilot-workspace.json"),
    JSON.stringify(workspaceManifest)
  );

  const sandboxManager = new SandboxManager({ baseDir: root, persistSandbox: false });
  const lifecycle = new RuntimeLifecycleManager(
    sandboxManager,
    new DependencyResolver(true, runner),
    new BuildRunner(true, runner),
    new DependencyServiceManager(true, runner),
    new ServiceStartupManager(true, runner),
    new TestRunner(true, runner),
    runner
  );

  try {
    const result = await lifecycle.run(sandboxId);
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(result.services.map((service) => service.kind), ["api", "worker", "frontend"]);
    assert.strictEqual(result.endpoints.length, 2);
    assert.notStrictEqual(result.endpoints[0].hostPort, result.endpoints[1].hostPort);
    assert.strictEqual(Object.keys(result.logs).length, 3);
    const webEndpoint = result.endpoints.find((endpoint) => endpoint.kind === "frontend");
    assert.ok(webEndpoint);
    assert.strictEqual(await fetch(webEndpoint!.externalUrl).then((response) => response.text()), "web-ok");
    console.log(JSON.stringify({
      lifecycle: "multi-service-verified",
      services: result.services.map((service) => ({
        id: service.serviceId,
        kind: service.kind,
        attempts: service.attempts
      })),
      endpoints: result.endpoints
    }, null, 2));
  } finally {
    await lifecycle.cleanupRuntime(sandboxId);
    await runner.run({
      sandboxId: `${sandboxId}-workspace-cleanup`,
      workspaceDir: repositoryRoot,
      command: ["rm", "-rf", "node_modules"],
      user: null
    }).catch(() => undefined);
    await new CleanupManager().deleteWorkspaceDir(root);
  }
}

runDockerSmoke().catch((error) => {
  console.error("DOCKER SMOKE TEST FAILED:", error);
  process.exit(1);
});
