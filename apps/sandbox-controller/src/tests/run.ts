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
  public override async run(_options: ContainerRunOptions): Promise<ContainerRunResult> {
    return { success: true, exitCode: 0, log: "real command result fixture", timedOut: false };
  }

  public override async startDetached(
    _options: ContainerRunOptions & { ports?: number[] }
  ): Promise<ContainerRunResult & { containerId?: string; portBindings: any[] }> {
    return {
      success: true,
      exitCode: 0,
      log: "container-fixture",
      timedOut: false,
      containerId: "container-fixture",
      portBindings: (_options.ports || []).map((port) => ({
        containerPort: port,
        hostPort: 49_173,
        internalUrl: `http://application:${port}`,
        externalUrl: "http://127.0.0.1:49173"
      }))
    };
  }

  public override async stop(_containerId: string): Promise<void> {}
  public override async createNetwork(_sandboxId: string): Promise<string> { return "opspilot-test"; }
  public override async removeNetwork(_networkName: string): Promise<void> {}
  public override async cleanupSandboxResources(_sandboxId: string): Promise<void> {}
  public override async exec(_containerId: string, _command: string[]): Promise<ContainerRunResult> {
    return { success: true, exitCode: 0, log: "ready", timedOut: false };
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
  assert.deepStrictEqual(serviceManager.getActiveContainers("sb-test"), ["container-fixture"]);
  await serviceManager.stopAll("sb-test");

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
  assert.strictEqual(lifecycleResult.endpoints[0].hostPort, 49_173);
  assert.ok(lifecycleResult.stages.some((stage) => stage.stage === "workflow:http-health"));
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
