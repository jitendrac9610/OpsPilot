import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { SandboxManager } from "../sandbox.js";
import { DependencyResolver } from "../dependencyResolver.js";
import { ServiceStartupManager } from "../serviceStartup.js";
import { TelemetryCollector } from "../telemetry.js";
import { TestRunner } from "../testRunner.js";
import { CleanupManager } from "../cleanup.js";
import { server } from "../index.js";

async function runTests() {
  console.log("=== Running Sandbox Controller Unit Tests ===");

  const sm = new SandboxManager();
  const dr = new DependencyResolver(true); 
  const ss = new ServiceStartupManager(true);
  const tc = new TelemetryCollector();
  const tr = new TestRunner(true);
  const cl = new CleanupManager();

  let sandboxId: string | null = null;
  let workspaceDir: string | null = null;

  console.log("\n1. Testing Sandbox Workspace Allocation...");
  {
    sandboxId = await sm.createSandbox("test-snapshot-sha");
    assert(sandboxId.startsWith("sb-"));
    
    workspaceDir = sm.getWorkspaceDir(sandboxId);
    assert(fs.existsSync(workspaceDir));
    assert(fs.existsSync(path.join(workspaceDir, "package.json")));
    assert(fs.existsSync(path.join(workspaceDir, "index.js")));
    console.log("✓ Sandbox allocated successfully.");
  }

  console.log("\n2. Testing Dependency Resolver...");
  {
    const res = await dr.resolve(workspaceDir!, sandboxId);
    assert.strictEqual(res.success, true);
    console.log("✓ Dependency resolver completed.");
  }

  console.log("\n3. Testing Service Startup Manager...");
  {
    const res = await ss.startService(
      sandboxId,
      workspaceDir!,
      "test-service",
      "node index.js"
    );
    assert.strictEqual(res.success, true);
    assert(res.pid !== undefined);

    const procs = ss.getActiveProcesses(sandboxId);
    assert.strictEqual(procs.length, 1);
    console.log("✓ Service started successfully.");
  }

  console.log("\n4. Testing Telemetry Collector...");
  {
    const procs = ss.getActiveProcesses(sandboxId);
    const metrics = tc.captureSystemMetrics(procs);
    assert.strictEqual(metrics.cpuUsage, 15); 
    assert.strictEqual(metrics.memoryUsageBytes, 50 * 1024 * 1024);
    console.log("✓ Telemetry collection completed.");
  }

  console.log("\n5. Testing Test Runner...");
  {
    const res = await tr.runTests(
      sandboxId,
      workspaceDir!,
      "unit",
      "node test.js"
    );
    assert.strictEqual(res.success, true);
    assert(res.log.includes("Tests run: 5"));
    console.log("✓ Test execution completed.");
  }

  console.log("\n6. Testing Cleanup Manager...");
  {
    const procs = ss.getActiveProcesses(sandboxId);
    await cl.terminateProcesses(procs);
    ss.clearProcesses(sandboxId);

    await cl.deleteWorkspaceDir(workspaceDir!);
    assert(!fs.existsSync(workspaceDir!));
    console.log("✓ Cleanup and workspace erasure completed.");
  }

  server.close();
  console.log("\nALL SANDBOX CONTROLLER TESTS PASSED SUCCESSFULLY!");
}

runTests().catch((err) => {
  console.error("\nTEST RUN FAILED:", err);
  server.close();
  process.exit(1);
});
