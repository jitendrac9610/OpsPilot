import assert from "node:assert";
import { WorkflowDiscoverer } from "../discovery.js";
import { WorkflowDrivers } from "../drivers.js";
import { AssertionEngine } from "../assertions.js";
import { CorrelationManager } from "../correlation.js";
import { FailureLocalizer } from "../localization.js";

async function runTests() {
  console.log("=== Running Workflow Engine Unit Tests ===");

  const wd = new WorkflowDiscoverer(true);
  const dr = new WorkflowDrivers();
  const ae = new AssertionEngine(true);
  const cm = new CorrelationManager(true);
  const fl = new FailureLocalizer(true);

  console.log("\n1. Testing Workflow Discovery...");
  {
    const discovered = await wd.discover("proj-123", "/mock/repo/dir");
    assert(discovered.length >= 2);
    assert.strictEqual(discovered[0].name, "Create and join interview");
    assert.strictEqual(discovered[1].name, "Stripe Webhook Invoice Process");
    console.log("✓ Workflows discovered successfully.");
  }

  console.log("\n2. Testing HTTP/Browser Drivers...");
  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ success: true })
      } as Response;
    };

    const httpRes = await dr.executeHTTPStep({
      method: "POST",
      url: "/api/interviews",
      payload: { candidate: "Alice" }
    });
    assert.strictEqual(httpRes.success, true);
    assert.strictEqual(httpRes.status, 201);
    assert(httpRes.log.includes("completed"));

    globalThis.fetch = originalFetch;

    const browserRes = await dr.executeBrowserStep({
      action: "navigate",
      url: "/interviews/room"
    });
    assert.strictEqual(browserRes.success, true);
    assert(browserRes.log.includes("navigated to URL"));

    console.log("✓ HTTP/Browser driver executions passed.");
  }

  console.log("\n3. Testing Assertion Engine...");
  {
    const dbAssert = await ae.assertDBState({ query: "db.interviews.findOne({ candidate: 'Alice' })" });
    assert.strictEqual(dbAssert.success, true);

    const queueAssert = await ae.assertQueueEvent({ event: "interview.created" });
    assert.strictEqual(queueAssert.success, true);

    const sdkAssert = await ae.assertSDKState({ sdk: "GetStream", action: "room_exists" });
    assert.strictEqual(sdkAssert.success, true);
    console.log("✓ Multi-dimensional assertions passed.");
  }

  console.log("\n4. Testing Correlation and Logging...");
  {
    const runId = await cm.startWorkflowRun("wf-123");
    assert(runId.startsWith("wfrun-"));

    await cm.recordStepRun(runId, "step-1", "COMPLETED", ["Step 1 started", "Step 1 passed"]);
    await cm.completeWorkflowRun(runId, "COMPLETED");
    console.log("✓ Correlation tracking completed.");
  }

  console.log("\n5. Testing Failure Localization...");
  {
    const boundaryId = await fl.localizeFailure("wfrun-123", "Verify GetStream room", "Room not found on GetStream servers");
    assert(boundaryId.startsWith("fb-"));
    console.log("✓ Failure localized and recorded.");
  }

  console.log("\nALL WORKFLOW ENGINE TESTS PASSED SUCCESSFULLY!");
}

runTests().catch((err) => {
  console.error("\nTEST RUN FAILED:", err);
  process.exit(1);
});
