import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import archiver from "archiver";
import { SandboxManager, SandboxProvisionError } from "../sandbox.js";
import { discoverExecutionManifest } from "../executionManifest.js";
import { ContainerRunner, ContainerRunOptions, ContainerRunResult } from "../containerRunner.js";
import { DependencyResolver } from "../dependencyResolver.js";
import { ServiceStartupManager } from "../serviceStartup.js";
import { TestRunner } from "../testRunner.js";
import { CleanupManager } from "../cleanup.js";
import { BuildRunner } from "../buildRunner.js";
import { DependencyServiceManager } from "../dependencyServices.js";
import { RuntimeLifecycleManager } from "../runtimeLifecycle.js";

class FakeContainerRunner extends ContainerRunner {
  public readonly starts: Array<ContainerRunOptions & { ports?: number[] }> = [];
  private nextContainer = 0;

  public override async run(_options: ContainerRunOptions): Promise<ContainerRunResult> {
    return { success: true, exitCode: 0, log: "real command result fixture", timedOut: false };
  }

  public override async startDetached(
    _options: ContainerRunOptions & { ports?: number[] }
  ): Promise<ContainerRunResult & { containerId?: string; portBindings: any[] }> {
    this.starts.push(_options);
    this.nextContainer++;
    const containerId = `${_options.name || "service"}-container-${this.nextContainer}`;
    return {
      success: true,
      exitCode: 0,
      log: containerId,
      timedOut: false,
      containerId,
      portBindings: (_options.ports || []).map((port) => ({
        containerPort: port,
        hostPort: 49_172 + this.nextContainer,
        internalUrl: `http://${_options.networkAliases?.[0] || "application"}:${port}`,
        externalUrl: `http://127.0.0.1:${49_172 + this.nextContainer}`
      }))
    };
  }

  public override async buildImage(options: {
    sandboxId: string;
    workspaceDir: string;
    context: string;
    dockerfile?: string;
    name: string;
    network?: string;
  }): Promise<ContainerRunResult & { image: string }> {
    return {
      success: true,
      exitCode: 0,
      log: `built ${options.name}`,
      timedOut: false,
      image: `opspilot/test/${options.name}:latest`
    };
  }

  public override async stop(_containerId: string): Promise<void> {}
  public override async createNetwork(_sandboxId: string): Promise<string> { return "opspilot-test"; }
  public override async removeNetwork(_networkName: string): Promise<void> {}
  public override async cleanupSandboxResources(_sandboxId: string): Promise<void> {}
  public override async exec(_containerId: string, _command: string[]): Promise<ContainerRunResult> {
    return { success: true, exitCode: 0, log: "ready", timedOut: false };
  }
  public override async logs(containerId: string): Promise<ContainerRunResult> {
    return { success: true, exitCode: 0, log: `logs:${containerId}`, timedOut: false };
  }
  public override async isRunning(_containerId: string): Promise<boolean> { return true; }
}

class FlakyContainerRunner extends FakeContainerRunner {
  private failedOnce = false;

  public override async startDetached(
    options: ContainerRunOptions & { ports?: number[] }
  ): Promise<ContainerRunResult & { containerId?: string; portBindings: any[] }> {
    if (!this.failedOnce) {
      this.failedOnce = true;
      this.starts.push(options);
      return {
        success: false,
        exitCode: 1,
        log: "intentional first-start failure",
        timedOut: false,
        portBindings: []
      };
    }
    return super.startDetached(options);
  }
}

async function runTests() {
  const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opspilot-sandbox-test-"));
  const repositoryRoot = path.join(tempRoot, "repository");
  await fs.promises.mkdir(repositoryRoot, { recursive: true });
  await fs.promises.writeFile(
    path.join(repositoryRoot, "package.json"),
    JSON.stringify({
      scripts: { start: "node index.js", test: "node --test", build: "tsc" },
      dependencies: { express: "1.0.0", pg: "1.0.0", "@prisma/client": "1.0.0" }
    })
  );
  await fs.promises.writeFile(path.join(repositoryRoot, "package-lock.json"), "{}");
  const manifest = await discoverExecutionManifest(repositoryRoot);

  assert.deepStrictEqual(manifest.installCommand, ["npm", "ci"]);
  assert.strictEqual(manifest.testCommands[0].type, "unit");
  assert.strictEqual(manifest.services[0].type, "postgresql");
  assert.deepStrictEqual(manifest.migrationCommand, ["npm", "exec", "--", "prisma", "migrate", "deploy"]);
  assert.strictEqual(manifest.supported, true);

  const multiRoot = path.join(tempRoot, "multi-service");
  await fs.promises.mkdir(path.join(multiRoot, "apps", "api", "src"), { recursive: true });
  await fs.promises.mkdir(path.join(multiRoot, "apps", "worker", "src"), { recursive: true });
  await fs.promises.mkdir(path.join(multiRoot, "apps", "web", "src"), { recursive: true });
  await fs.promises.writeFile(path.join(multiRoot, "package.json"), JSON.stringify({
    name: "example-monorepo",
    private: true,
    packageManager: "pnpm@9.1.4",
    workspaces: ["apps/*"],
    scripts: { build: "turbo build" }
  }));
  await fs.promises.writeFile(path.join(multiRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await fs.promises.writeFile(path.join(multiRoot, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
  await fs.promises.writeFile(path.join(multiRoot, "apps", "api", "package.json"), JSON.stringify({
    name: "@example/api",
    scripts: { start: "node src/index.js", test: "node --test" },
    dependencies: { express: "1.0.0", pg: "1.0.0" }
  }));
  await fs.promises.writeFile(
    path.join(multiRoot, "apps", "api", "src", "index.js"),
    "require('express')().listen(process.env.PORT || 4100)"
  );
  await fs.promises.writeFile(path.join(multiRoot, "apps", "worker", "package.json"), JSON.stringify({
    name: "@example/worker",
    scripts: { start: "node src/index.js" },
    dependencies: { bullmq: "1.0.0" }
  }));
  await fs.promises.writeFile(
    path.join(multiRoot, "apps", "worker", "src", "index.js"),
    "const { Worker } = require('bullmq'); new Worker('orders', async () => {})"
  );
  await fs.promises.writeFile(path.join(multiRoot, "apps", "web", "package.json"), JSON.stringify({
    name: "@example/web",
    scripts: { start: "next start" },
    dependencies: { next: "1.0.0", react: "1.0.0" }
  }));
  await fs.promises.writeFile(
    path.join(multiRoot, "apps", "web", "src", "index.tsx"),
    "import React from 'react'; export default function Page(){ return <main /> }"
  );
  await fs.promises.writeFile(path.join(multiRoot, "docker-compose.yml"), `
services:
  postgres:
    image: postgres:16
  redis:
    image: redis:7
  api:
    build:
      context: ./apps/api
    ports:
      - "4100:4100"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_started
  worker:
    build: ./apps/worker
    depends_on:
      - api
      - redis
  web:
    build: ./apps/web
    ports:
      - "3000:3000"
    depends_on:
      - api
      - worker
`);
  const multiManifest = await discoverExecutionManifest(multiRoot);
  assert.strictEqual(multiManifest.version, 2);
  assert.strictEqual(multiManifest.repositoryKind, "hybrid");
  assert.deepStrictEqual(
    multiManifest.startCommands.map((service) => service.kind),
    ["api", "worker", "frontend"]
  );
  assert.deepStrictEqual(
    multiManifest.services.map((service) => service.type).sort(),
    ["postgresql", "redis"]
  );
  assert.ok(multiManifest.startCommands[1].dependsOn.includes(multiManifest.startCommands[0].id));
  assert.ok(multiManifest.startCommands[2].dependsOn.includes(multiManifest.startCommands[1].id));
  assert.strictEqual(
    multiManifest.healthChecks.find((check) => check.serviceId === multiManifest.startCommands[1].id)?.type,
    "process"
  );

  const failingManager = new SandboxManager({
    baseDir: tempRoot,
    persistSandbox: false,
    loadSnapshot: async () => ({ id: "snap-1", commitSha: "abc123", archiveUrl: "file:///missing.zip" }),
    downloadSnapshot: async () => { throw new Error("not found"); },
    loadIndexedFiles: async () => []
  });
  await assert.rejects(
    () => failingManager.createSandbox("snap-1"),
    (error: unknown) => error instanceof SandboxProvisionError && error.code === "SNAPSHOT_DOWNLOAD_FAILED"
  );

  const packageContent = JSON.stringify({
    scripts: { start: "node index.js", test: "node --test" },
    dependencies: { express: "1.0.0" }
  });
  const snapshotArchive = await createZip({
    "opspilot-snapshot.json": JSON.stringify({ repositoryId: "repo-1", commitSha: "abc123" }),
    "package.json": packageContent,
    "package-lock.json": "{}"
  });
  const packageHash = crypto.createHash("sha256").update(packageContent).digest("hex");
  const hydratedManager = new SandboxManager({
    baseDir: path.join(tempRoot, "hydrated"),
    persistSandbox: false,
    loadSnapshot: async () => ({ id: "snap-2", commitSha: "abc123", archiveUrl: "memory://snap-2" }),
    downloadSnapshot: async () => snapshotArchive,
    loadIndexedFiles: async () => [{ path: "package.json", hash: packageHash }]
  });
  const hydratedSandboxId = await hydratedManager.createSandbox("snap-2");
  const hydratedManifest = hydratedManager.getWorkspaceManifest(hydratedSandboxId);
  assert.strictEqual(hydratedManifest.commitSha, "abc123");
  assert.strictEqual(hydratedManifest.verifiedFileCount, 1);
  assert.strictEqual(
    crypto.createHash("sha256")
      .update(await fs.promises.readFile(path.join(hydratedManifest.repositoryRoot, "package.json")))
      .digest("hex"),
    packageHash
  );

  const runner = new FakeContainerRunner();
  const dependencyResult = await new DependencyResolver(true, runner).resolve(repositoryRoot, "sb-test", manifest);
  assert.strictEqual(dependencyResult.success, true);

  const buildResult = await new BuildRunner(true, runner).build("sb-test", repositoryRoot, manifest);
  assert.strictEqual(buildResult.success, true);
  assert.deepStrictEqual(buildResult.command, ["npm", "run", "build"]);

  const testResult = await new TestRunner(true, runner).runTests("sb-test", repositoryRoot, "unit", manifest);
  assert.strictEqual(testResult.success, true);

  const serviceManager = new ServiceStartupManager(true, runner, async () => true);
  const serviceResult = await serviceManager.startService(
    "sb-test",
    repositoryRoot,
    { id: "app", name: "app", command: ["npm", "start"], port: 3000 }
  );
  assert.strictEqual(serviceResult.success, true);
  assert.strictEqual(serviceManager.getActiveContainers("sb-test").length, 1);
  await serviceManager.stopAll("sb-test");

  const multiRunner = new FakeContainerRunner();
  const multiServiceManager = new ServiceStartupManager(true, multiRunner, async () => true);
  const multiStart = await multiServiceManager.startServices(
    "sb-multi",
    multiRoot,
    multiManifest.startCommands,
    { NODE_ENV: "test" },
    "opspilot-test",
    multiManifest.healthChecks
  );
  assert.strictEqual(multiStart.success, true);
  assert.strictEqual(multiStart.services.length, 3);
  assert.strictEqual(multiStart.endpoints.length, 2);
  assert.notStrictEqual(multiStart.endpoints[0].hostPort, multiStart.endpoints[1].hostPort);
  assert.ok(multiStart.environment.API_URL?.includes(multiManifest.startCommands[0].id));
  assert.strictEqual(multiRunner.starts[2].environment?.NEXT_PUBLIC_API_URL, multiStart.environment.API_URL);
  assert.deepStrictEqual(Object.keys(await multiServiceManager.collectLogs("sb-multi")).sort(), [
    multiManifest.startCommands[0].id,
    multiManifest.startCommands[1].id,
    multiManifest.startCommands[2].id
  ].sort());
  await multiServiceManager.stopAll("sb-multi");

  const flakyRunner = new FlakyContainerRunner();
  const retryManager = new ServiceStartupManager(true, flakyRunner, async () => true);
  const retryService = { ...multiManifest.startCommands[0], build: undefined, restartAttempts: 1 };
  const retryResult = await retryManager.startServices(
    "sb-retry",
    multiRoot,
    [retryService],
    {},
    "opspilot-test",
    multiManifest.healthChecks.filter((check) => check.serviceId === retryService.id)
  );
  assert.strictEqual(retryResult.success, true);
  assert.strictEqual(retryResult.services[0].attempts, 2);
  assert.strictEqual(flakyRunner.starts.length, 2);
  await retryManager.stopAll("sb-retry");

  const lifecycleServiceManager = new ServiceStartupManager(true, runner, async () => true);
  const lifecycle = new RuntimeLifecycleManager(
    hydratedManager,
    new DependencyResolver(true, runner),
    new BuildRunner(true, runner),
    new DependencyServiceManager(true, runner),
    lifecycleServiceManager,
    new TestRunner(true, runner),
    runner,
    async () => ({ status: 200, body: "healthy" })
  );
  const lifecycleResult = await lifecycle.run(hydratedSandboxId);
  assert.strictEqual(lifecycleResult.success, true);
  assert.strictEqual(lifecycleResult.status, "RUNTIME_VERIFIED");
  assert.ok(lifecycleResult.endpoints[0].hostPort >= 49_173);
  assert.ok(lifecycleResult.stages.some((stage) => stage.stage.startsWith("workflow:http-health:")));
  assert.ok(lifecycleResult.logs.application);
  await lifecycle.cleanupRuntime(hydratedSandboxId);

  await new CleanupManager().deleteWorkspaceDir(tempRoot);
  assert.strictEqual(fs.existsSync(tempRoot), false);
  console.log("ALL SANDBOX CONTROLLER TESTS PASSED");
}

async function createZip(files: Record<string, string>): Promise<Buffer> {
  const archive = archiver("zip", { zlib: { level: 9 } });
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const completed = new Promise<void>((resolve, reject) => {
    output.on("end", resolve);
    output.on("error", reject);
  });
  archive.pipe(output);
  for (const [name, content] of Object.entries(files)) archive.append(content, { name });
  await archive.finalize();
  await completed;
  return Buffer.concat(chunks);
}

runTests().catch((error) => {
  console.error("TEST RUN FAILED:", error);
  process.exit(1);
});
