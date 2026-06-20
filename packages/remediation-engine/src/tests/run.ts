import assert from "node:assert";
import { RemediationPlanManager } from "../plans.js";
import { ChangeSetManager } from "../changesets.js";
import { WorkflowReplayer } from "../replay.js";
import { VerificationGates } from "../gates.js";
import { AlternativeRepairLoop } from "../loop.js";

async function runTests() {
  console.log("=== Running Remediation Engine Unit Tests ===");

  const pm = new RemediationPlanManager(true);
  const cm = new ChangeSetManager(true);
  const wr = new WorkflowReplayer();
  const vg = new VerificationGates(true);
  const ar = new AlternativeRepairLoop();

  const diagnosisId = "diag-123";

  console.log("\n1. Testing Remediation Plan Generation...");
  const planInfo = await pm.generatePlans(
    diagnosisId,
    "Fix DB Host Mismatch",
    "Missing DB_HOST env var",
    [{ action: "Add environment variable DB_HOST", file: ".env" }]
  );
  assert(planInfo.planId.startsWith("plan-"));
  assert.strictEqual(planInfo.alternatives.length, 2);
  console.log("✓ Plans created and scored.");

  console.log("\n2. Testing ChangeSet Creation...");
  const csInfo = await cm.createChangeSet(planInfo.planId, [
    { path: ".env", diff: "+DB_HOST=localhost" }
  ]);
  assert(csInfo.changeSetId.startsWith("cs-"));
  assert(csInfo.branchName.startsWith("opspilot-fix-"));
  console.log("✓ Branch and patches changeset completed.");

  console.log("\n3. Testing Workflow Replay...");
  const steps = [
    { type: "HTTP", config: { method: "POST", url: "/api/interviews", payload: {} } },
    { type: "BROWSER", config: { action: "navigate", url: "/room" } }
  ];
  
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return {
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ success: true })
    } as Response;
  };

  const replayRes = await wr.replay(steps);
  assert.strictEqual(replayRes.success, true);
  assert.strictEqual(replayRes.logs.length, 2);

  globalThis.fetch = originalFetch;
  console.log("✓ Workflow replay completed.");

  console.log("\n4. Testing Verification Gates...");
  const gatesConfig = {
    runBuild: true,
    runTests: true,
    runReplay: true,
    checkSecurity: true
  };
  const evalRes = await vg.evaluateGates(planInfo.planId, gatesConfig, true, true, true);
  assert.strictEqual(evalRes.success, true);
  assert(evalRes.runId.startsWith("vr-"));
  console.log("✓ Verification gates passed.");

  console.log("\n5. Testing Alternative Repair Loop...");
  const loopRes = await ar.runRepairLoop(
    planInfo.planId,
    gatesConfig,
    planInfo.alternatives,
    3
  );
  assert.strictEqual(loopRes.success, true);
  assert.strictEqual(loopRes.attemptCount, 2); 
  assert.strictEqual(loopRes.finalLogs.length, 4);
  console.log("✓ Repair loop completed successfully.");

  console.log("\nALL REMEDIATION ENGINE TESTS PASSED SUCCESSFULLY!");
}

runTests().catch((err) => {
  console.error("\nTEST RUN FAILED:", err);
  process.exit(1);
});
