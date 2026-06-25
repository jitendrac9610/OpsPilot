import assert from "node:assert";
import { ZodError } from "zod";
import { EvidenceEventSchema, EvidenceEvent } from "@opspilot/schemas";
import { CorrelationManager } from "../correlation.js";
import { prisma } from "@opspilot/database";

export async function runPhase13Tests() {
  console.log("=== Running Phase 13 Cross-service Correlation Tests ===");

  // ----------------------------------------------------
  // Test 1: EvidenceEvent Schema Validation
  // ----------------------------------------------------
  console.log("Testing EvidenceEvent Schema Validation...");

  const validEvent: EvidenceEvent = {
    id: "evt_1234567",
    runId: "run_xyz",
    workflowId: "wf_abc",
    correlationId: "trace_111",
    parentId: "evt_0000000",
    timestamp: new Date().toISOString(),
    service: "api",
    protocol: "http",
    operation: "GET /orders",
    timing: 150,
    success: true,
    request: { method: "GET" },
    response: { status: 200 },
    sourceSymbol: "routes/orders.ts",
    artifacts: { headers: { "X-Test": "123" } }
  };

  // Should parse successfully
  const parsed = EvidenceEventSchema.parse(validEvent);
  assert.strictEqual(parsed.id, "evt_1234567");
  assert.strictEqual(parsed.protocol, "http");

  // Invalid event validation
  const invalidEvent = {
    ...validEvent,
    protocol: "invalid_protocol" // Not a valid EvidenceProtocol
  };

  assert.throws(() => {
    EvidenceEventSchema.parse(invalidEvent);
  }, ZodError, "Expected validation to fail for invalid protocol");

  console.log("✓ EvidenceEvent Schema Validation verified.");

  // ----------------------------------------------------
  // Test 2: Chronological Timeline Sorting & Database Persist
  // ----------------------------------------------------
  console.log("Testing Timeline Persistence and Sorting...");

  const correlation = new CorrelationManager(false);
  const runId = `testrun-${Math.random().toString(36).substring(2, 9)}`;

  // Create a clean org, project, repo
  const org = await prisma.organization.create({
    data: { name: "Phase 13 Test Org" }
  });
  const project = await prisma.project.create({
    data: { organizationId: org.id, name: "Phase 13 Project" }
  });
  const repo = await prisma.repository.create({
    data: { projectId: project.id, name: "phase13-repo", gitUrl: "mock-url", branch: "main" }
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

  const event1: EvidenceEvent = {
    id: "evt-2",
    runId,
    workflowId: "wf-1",
    correlationId: "trace-1",
    timestamp: "2026-06-25T11:00:10.000Z",
    service: "api",
    protocol: "http",
    operation: "POST /orders",
    success: true,
    artifacts: {}
  };

  const event2: EvidenceEvent = {
    id: "evt-1",
    runId,
    workflowId: "wf-1",
    correlationId: "trace-1",
    timestamp: "2026-06-25T11:00:00.000Z", // Earlier timestamp
    service: "api",
    protocol: "http",
    operation: "POST /auth/login",
    success: true,
    artifacts: {}
  };

  await correlation.recordEvidenceEvent(runId, event1);
  await correlation.recordEvidenceEvent(runId, event2);

  const timeline = await correlation.getEvidenceTimeline(runId);
  
  assert.strictEqual(timeline.length, 2, "Expected 2 events in timeline");
  // Check chronological order (event2 has earlier timestamp, so it should be first)
  assert.strictEqual(timeline[0].id, "evt-1", "Expected earliest event first");
  assert.strictEqual(timeline[1].id, "evt-2", "Expected later event second");

  console.log("✓ Timeline Persistence and Sorting verified.");

  // ----------------------------------------------------
  // Test 3: Causal Dependency Tracking
  // ----------------------------------------------------
  console.log("Testing Causal Dependency Tracking (Parent-Child)...");

  // Step 1: Parent step
  const parentEvent: EvidenceEvent = {
    id: "parent-evt",
    runId,
    workflowId: "wf-1",
    correlationId: "trace-1",
    timestamp: "2026-06-25T11:00:20.000Z",
    service: "api",
    protocol: "http",
    operation: "POST /orders",
    success: true,
    artifacts: {}
  };

  // Step 2: Child step depends on parent step
  const childEvent: EvidenceEvent = {
    id: "child-evt",
    runId,
    workflowId: "wf-1",
    correlationId: "trace-1",
    parentId: "parent-evt", // Linked to parent
    timestamp: "2026-06-25T11:00:30.000Z",
    service: "database",
    protocol: "database",
    operation: "Post-run Diff Assertion (Order)",
    success: true,
    artifacts: {}
  };

  await correlation.recordEvidenceEvent(runId, parentEvent);
  await correlation.recordEvidenceEvent(runId, childEvent);

  const fullTimeline = await correlation.getEvidenceTimeline(runId);
  const retrievedChild = fullTimeline.find(e => e.id === "child-evt");
  assert.ok(retrievedChild, "Expected child event to be present");
  assert.strictEqual(retrievedChild.parentId, "parent-evt", "Child event should be causally linked to parent");

  // Clean up database mock run, repo, project, org
  await prisma.diagnosticRun.delete({ where: { id: runId } }).catch(() => {});
  await prisma.repository.delete({ where: { id: repo.id } }).catch(() => {});
  await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
  await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});

  console.log("✓ Causal Dependency Tracking verified.");
  console.log("✓ All Phase 13 Cross-service Correlation Tests Passed!");
}
