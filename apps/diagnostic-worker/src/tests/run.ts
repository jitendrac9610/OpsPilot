import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

function loadRootEnv() {
  const envPath = path.resolve(__dirname, "../../../../.env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    process.env[key] ||= value;
  }
}

async function runTests() {
  loadRootEnv();
  process.env.NODE_ENV = "test";
  const { prisma } = await import("@opspilot/database");
  const {
    markStalledDiagnosticRuns,
    progressForStage,
    recordDiagnosticHeartbeat
  } = await import("../heartbeat.js");

  console.log("=== Running Diagnostic Worker Tests ===");

  assert.strictEqual(progressForStage("CLONING"), 5);
  assert.strictEqual(progressForStage("FINISHED"), 100);

  const org = await prisma.organization.create({
    data: { name: "Diagnostic Worker Test Org" }
  });
  const project = await prisma.project.create({
    data: { organizationId: org.id, name: "Diagnostic Worker Project" }
  });
  const repo = await prisma.repository.create({
    data: {
      projectId: project.id,
      name: "diagnostic-worker-repo",
      gitUrl: "mock-repo-url",
      branch: "main"
    }
  });

  try {
    const staleRun = await prisma.diagnosticRun.create({
      data: {
        repositoryId: repo.id,
        status: "RUNNING",
        stage: "EXECUTING_WORKFLOW",
        lastHeartbeatAt: new Date(Date.now() - 120_000)
      }
    });
    const freshRun = await prisma.diagnosticRun.create({
      data: {
        repositoryId: repo.id,
        status: "RUNNING",
        stage: "SANDBOX_START",
        lastHeartbeatAt: new Date()
      }
    });

    await recordDiagnosticHeartbeat(freshRun.id, "test-worker");
    const failedCount = await markStalledDiagnosticRuns(90_000, {
      repositoryId: repo.id
    });
    assert.ok(failedCount >= 1);

    const updatedStale = await prisma.diagnosticRun.findUniqueOrThrow({
      where: { id: staleRun.id }
    });
    assert.strictEqual(updatedStale.status, "FAILED");
    assert.strictEqual(updatedStale.failureCode, "WORKER_HEARTBEAT_TIMEOUT");
    assert.strictEqual(updatedStale.retryable, true);

    const updatedFresh = await prisma.diagnosticRun.findUniqueOrThrow({
      where: { id: freshRun.id }
    });
    assert.strictEqual(updatedFresh.status, "RUNNING");
    assert.strictEqual(updatedFresh.workerId, "test-worker");
    assert.ok(updatedFresh.progress >= progressForStage("SANDBOX_START"));

    console.log("ALL DIAGNOSTIC WORKER TESTS PASSED");
  } finally {
    await prisma.diagnosticRun.deleteMany({ where: { repositoryId: repo.id } }).catch(() => {});
    await prisma.repository.delete({ where: { id: repo.id } }).catch(() => {});
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
}

runTests().catch((err) => {
  console.error("DIAGNOSTIC WORKER TESTS FAILED:", err);
  process.exit(1);
});
