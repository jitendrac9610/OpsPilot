import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkflowDiscoverer } from "../discovery.js";
import { WorkflowDrivers } from "../drivers.js";
import { AssertionEngine } from "../assertions.js";
import { CorrelationManager } from "../correlation.js";
import { FailureLocalizer } from "../localization.js";

async function runTests() {
  const repositoryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opspilot-workflow-test-"));
  await fs.promises.writeFile(
    path.join(repositoryRoot, "routes.ts"),
    `router.post("/api/orders", async (_req, res) => res.status(201).json({ ok: true }));`
  );

  const discoverer = new WorkflowDiscoverer(true);
  const discovered = await discoverer.discover("proj-123", repositoryRoot);
  assert.strictEqual(discovered.length, 1);
  assert.strictEqual(discovered[0].steps[0].config.url, "/api/orders");

  const drivers = new WorkflowDrivers("http://localhost:4000", {
    execute: async (_config, correlationId) => ({
      success: true,
      log: `Playwright fixture completed [correlationId=${correlationId}]`
    })
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 201,
    text: async () => JSON.stringify({ success: true })
  } as Response);
  const httpResult = await drivers.executeHTTPStep({
    method: "POST",
    url: "/api/orders",
    expectedStatus: 201
  });
  assert.strictEqual(httpResult.success, true);
  assert(httpResult.correlationId);
  globalThis.fetch = originalFetch;

  const browserResult = await drivers.executeBrowserStep({ action: "navigate", url: "/orders" });
  assert.strictEqual(browserResult.success, true);

  const assertions = new AssertionEngine({
    database: async () => ({ success: true, log: "database fixture" }),
    queue: async () => ({ success: true, log: "queue fixture" }),
    sdk: async () => ({ success: true, log: "sdk fixture" })
  });
  assert.strictEqual((await assertions.assertDBState({ query: "SELECT 1" })).success, true);
  assert.strictEqual((await assertions.assertQueueEvent({ event: "order.created" })).success, true);
  assert.strictEqual((await assertions.assertSDKState({ sdk: "Stripe", action: "invoice_exists" })).success, true);

  const correlation = new CorrelationManager(true);
  const runId = await correlation.startWorkflowRun("wf-123");
  await correlation.recordStepRun(runId, "step-1", "COMPLETED", ["passed"]);
  await correlation.completeWorkflowRun(runId, "COMPLETED");

  const localizer = new FailureLocalizer(true);
  const boundaryId = await localizer.localizeFailure(runId, "POST /api/orders", "HTTP 500");
  assert(boundaryId.startsWith("fb-"));

  await fs.promises.rm(repositoryRoot, { recursive: true, force: true });
  console.log("ALL WORKFLOW ENGINE TESTS PASSED");
}

runTests().catch((error) => {
  console.error("TEST RUN FAILED:", error);
  process.exit(1);
});
