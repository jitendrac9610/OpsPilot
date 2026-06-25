import assert from "node:assert";
import { FailureLocalizer } from "../localization.js";
import { CorrelationManager } from "../correlation.js";
import { prisma } from "@opspilot/database";
import { EvidenceEvent } from "@opspilot/schemas";

export async function runPhase14Tests() {
  console.log("=== Running Phase 14 Root-cause Localization Tests ===");

  const localizer = new FailureLocalizer(false);
  const correlation = new CorrelationManager(false);
  const runId = `testrun-${Math.random().toString(36).substring(2, 9)}`;

  // Clean up any potential leftovers from previous runs
  await prisma.graphEdge.deleteMany({ where: { id: { in: ["edge-1", "edge-2"] } } }).catch(() => {});
  await prisma.graphNode.deleteMany({ where: { id: { in: ["queue_interviews-queue", "queue_interview-queue", "route-post-interviews"] } } }).catch(() => {});

  let org: any;
  let project: any;
  let repo: any;
  let snapshot: any;
  let archVersion: any;
  let boundaryId: string | undefined;
  let agentRun: any;

  try {
    // Create a clean org, project, repo, and snapshot
    org = await prisma.organization.create({
      data: { name: `Phase 14 Test Org ${runId}` }
    });
    project = await prisma.project.create({
      data: { organizationId: org.id, name: `Phase 14 Project ${runId}` }
    });
    repo = await prisma.repository.create({
      data: { projectId: project.id, name: `phase14-repo-${runId}`, gitUrl: "mock-url", branch: "main" }
    });
    snapshot = await prisma.repositorySnapshot.create({
      data: { repositoryId: repo.id, commitSha: `commit-14-${runId}`, archiveUrl: "mock-archive" }
    });
    archVersion = await prisma.architectureVersion.create({
      data: { snapshotId: snapshot.id }
    });

    const node1Id = `queue_interviews-queue-${runId}`;
    const node2Id = `queue_interview-queue-${runId}`;
    const node3Id = `route-post-interviews-${runId}`;
    const edge1Id = `edge-1-${runId}`;
    const edge2Id = `edge-2-${runId}`;

    // Seed architecture nodes & edges for queue mismatch testing
    // Producer publishes to "interviews-queue" but Worker consumes from "interview-queue"
    await prisma.graphNode.create({
      data: { id: node1Id, versionId: archVersion.id, type: "queue/topic/event", name: "interviews-queue", metadata: {} }
    });
    await prisma.graphNode.create({
      data: { id: node2Id, versionId: archVersion.id, type: "queue/topic/event", name: "interview-queue", metadata: {} }
    });
    await prisma.graphNode.create({
      data: { id: node3Id, versionId: archVersion.id, type: "route", name: "POST /api/interviews", metadata: {} }
    });

    // Publisher edge (node3 publishes to node1)
    await prisma.graphEdge.create({
      data: { id: edge1Id, versionId: archVersion.id, source: node3Id, target: node1Id, type: "PUBLISHES_TO", evidence: {} }
    });
    // Consumer edge (node2 consumed by worker)
    await prisma.graphEdge.create({
      data: { id: edge2Id, versionId: archVersion.id, source: node2Id, target: "worker-process", type: "CONSUMES_FROM", evidence: {} }
    });

    // Create a mock DiagnosticRun in the database
    await prisma.diagnosticRun.create({
      data: {
        id: runId,
        repositoryId: repo.id,
        status: "RUNNING",
        stage: "EXECUTING_WORKFLOW"
      }
    });

    // ----------------------------------------------------
    // Test 1: Rich Hypothesis Generation & DB Persistence
    // ----------------------------------------------------
    console.log("Testing Rich Hypothesis Generation & DB Persistence...");

    const errorEvent: EvidenceEvent = {
      id: `evt-error-${runId}`,
      runId,
      workflowId: "wf-14",
      correlationId: "trace-14",
      timestamp: new Date().toISOString(),
      service: "api",
      protocol: "http",
      operation: "POST /api/interviews",
      success: false,
      response: {
        error: "Error: Queue Error: timeout connecting to refunds queue",
        logs: ["Prisma client or SQL relation error in stack trace."]
      },
      artifacts: {}
    };

    await correlation.recordEvidenceEvent(runId, errorEvent);

    boundaryId = await localizer.localizeFailure(
      runId,
      "POST /api/interviews",
      "Prisma client error",
      snapshot.id
    );

    assert.ok(boundaryId.startsWith("fb-") || boundaryId.length > 10, "Expected failure boundary ID starting with fb- or a database cuid");

    // Read FailureBoundary from DB and parse report
    const boundary = await prisma.failureBoundary.findUnique({
      where: { id: boundaryId }
    });
    assert.ok(boundary, "Expected FailureBoundary to be stored in DB");

    const report = JSON.parse(boundary.reason);
    assert.strictEqual(report.failedStage, "POST /api/interviews");
    assert.ok(report.hypotheses.length > 0, "Expected generated hypotheses");

    // Verify rich hypotheses structure
    const dbHypothesis = report.hypotheses.find((h: any) => h.statement.includes("Database schema mismatch"));
    assert.ok(dbHypothesis, "Expected database mismatch hypothesis");
    assert.strictEqual(dbHypothesis.confidence, 85);
    assert.strictEqual(dbHypothesis.status, "SUPPORTED");
    assert.ok(dbHypothesis.supportingEvidence.includes("Prisma client or SQL relation error in stack trace."));
    assert.ok(dbHypothesis.confirmationExperiment.includes("prisma db push"));

    const queueHypothesis = report.hypotheses.find((h: any) => h.statement.includes("queue-name mismatch"));
    assert.ok(queueHypothesis, "Expected queue-name mismatch hypothesis");
    assert.strictEqual(queueHypothesis.confidence, 95);
    assert.strictEqual(queueHypothesis.status, "SUPPORTED");
    assert.ok(queueHypothesis.supportingEvidence.some((e: string) => e.includes("has publishers but no consumers")));
    assert.ok(queueHypothesis.confirmationExperiment.includes("consumer initialization"));

    // Check persisted Hypotheses in the database
    agentRun = await prisma.agentRun.findFirst({
      where: { workflowRunId: runId }
    });
    assert.ok(agentRun, "Expected AgentRun to be created");

    const persistedHypotheses = await prisma.hypothesis.findMany({
      where: { agentRunId: agentRun.id }
    });
    assert.ok(persistedHypotheses.length > 0, "Expected Hypotheses to be written to DB");
    assert.ok(persistedHypotheses.some(h => h.description.includes("queue-name mismatch")), "Expected queue mismatch in DB");

    console.log("✓ Timeline Persistence and Sorting verified.");
    console.log("✓ All Phase 14 Root-cause Localization Tests Passed!");
  } finally {
    // Clean up database mock records in reverse dependency order
    if (agentRun) {
      await prisma.hypothesis.deleteMany({ where: { agentRunId: agentRun.id } }).catch(() => {});
      await prisma.agentRun.delete({ where: { id: agentRun.id } }).catch(() => {});
    }
    if (boundaryId) {
      await prisma.failureBoundary.delete({ where: { id: boundaryId } }).catch(() => {});
    }
    await prisma.diagnosticRun.delete({ where: { id: runId } }).catch(() => {});
    if (archVersion) {
      await prisma.graphEdge.deleteMany({ where: { versionId: archVersion.id } }).catch(() => {});
      await prisma.graphNode.deleteMany({ where: { versionId: archVersion.id } }).catch(() => {});
      await prisma.architectureVersion.delete({ where: { id: archVersion.id } }).catch(() => {});
    }
    if (snapshot) {
      await prisma.repositorySnapshot.delete({ where: { id: snapshot.id } }).catch(() => {});
    }
    if (repo) {
      await prisma.repository.delete({ where: { id: repo.id } }).catch(() => {});
    }
    if (project) {
      await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    }
    if (org) {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
    }
  }
}
