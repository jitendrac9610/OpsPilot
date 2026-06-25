import assert from "node:assert";
import { RemediationPlanManager } from "../plans.js";
import { ChangeSetManager } from "../changesets.js";
import { WorkflowReplayer } from "../replay.js";
import { VerificationGates } from "../gates.js";
import { AlternativeRepairLoop } from "../loop.js";
import { WorkflowDrivers } from "@opspilot/workflow-engine";
import { checkForFalseFixes, checkForSecurityIssues } from "../executor.js";

async function runTests() {
  console.log("=== Running Remediation Engine Unit Tests ===");

  const pm = new RemediationPlanManager(true);
  const cm = new ChangeSetManager(true);
  const wr = new WorkflowReplayer(new WorkflowDrivers("http://localhost:4000", {
    execute: async () => ({ success: true, log: "Playwright fixture completed" })
  }));
  const vg = new VerificationGates(true);
  const ar = new AlternativeRepairLoop({
    execute: async (_plan, attempt) => ({
      patchApplied: true,
      changedFiles: ["src/config.ts"],
      buildSuccess: true,
      testSuccess: attempt > 1,
      replaySuccess: attempt > 1,
      securitySuccess: true,
      logs: [`Executed real verification fixture for attempt ${attempt}`]
    })
  });

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
    {
      type: "HTTP",
      config: {
        method: "POST",
        url: "/api/interviews",
        payload: { owner: "${auth.userId}" },
        extractVariables: {
          "interview.id": ["$.data.id", "$.id"]
        }
      }
    },
    {
      type: "HTTP",
      config: {
        method: "GET",
        url: "/api/interviews/${interview.id}"
      }
    },
    { type: "BROWSER", config: { action: "navigate", url: "/room" } }
  ];

  const originalFetch = globalThis.fetch;
  const fetchedUrls: string[] = [];
  const correlationIds: string[] = [];
  globalThis.fetch = async (input, init) => {
    fetchedUrls.push(String(input));
    correlationIds.push(new Headers(init?.headers).get("x-opspilot-correlation-id") || "");
    return {
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ data: { id: "interview-123" } })
    } as Response;
  };

  const replayRes = await wr.replay(steps, {
    initialVariables: { "auth.userId": "user-123" }
  });
  assert.strictEqual(replayRes.success, true);
  assert.strictEqual(replayRes.logs.length, 3);
  assert.strictEqual(replayRes.variables["interview.id"], "interview-123");
  assert.strictEqual(fetchedUrls[1], "http://localhost:4000/api/interviews/interview-123");
  assert.strictEqual(new Set(correlationIds).size, 1);
  assert(replayRes.stepResults);
  assert.strictEqual(replayRes.stepResults.length, 3);
  assert.strictEqual(replayRes.stepResults[0].type, "HTTP");
  assert.strictEqual(replayRes.stepResults[0].success, true);

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
  assert.strictEqual(loopRes.finalLogs.length, 6);
  console.log("✓ Repair loop completed successfully.");

  console.log("\n6. Testing False Fix Detection...");
  const falseFixLogs: string[] = [];
  
  // Swallow errors
  assert.strictEqual(checkForFalseFixes("try { doSomething(); } catch (e) {}", falseFixLogs), true);
  assert.strictEqual(checkForFalseFixes("try { doSomething(); } catch (err) { console.log(err); }", falseFixLogs), true);
  
  // Removing assertions
  assert.strictEqual(checkForFalseFixes("- assert.strictEqual(foo, bar);", falseFixLogs), true);
  assert.strictEqual(checkForFalseFixes("- expect(foo).toBe(bar);", falseFixLogs), true);
  
  // Weakening status checks
  assert.strictEqual(checkForFalseFixes("- res.status === 200", falseFixLogs), true);
  
  // Skipping workers
  assert.strictEqual(checkForFalseFixes("// queue.add('job')", falseFixLogs), true);
  assert.strictEqual(checkForFalseFixes("// new Worker()", falseFixLogs), true);
  
  // Safe patch should pass
  assert.strictEqual(checkForFalseFixes("const a = 123;", falseFixLogs), false);
  console.log("✓ False fix detection passed.");

  console.log("\n7. Testing Security Check Gate...");
  const securityLogs: string[] = [];
  
  // Hardcoded secrets/credentials
  assert.strictEqual(checkForSecurityIssues("+ const api_key = \"sk_test_51Nz...\";", securityLogs), false);
  assert.strictEqual(checkForSecurityIssues("+ password = \"my-super-secret-password\";", securityLogs), false);
  
  // Unsafe execution
  assert.strictEqual(checkForSecurityIssues("+ eval(input);", securityLogs), false);
  assert.strictEqual(checkForSecurityIssues("+ execSync(cmd);", securityLogs), false);
  
  // Safe patch should pass
  assert.strictEqual(checkForSecurityIssues("+ const safeKey = config.key;", securityLogs), true);
  console.log("✓ Security checks passed.");

  console.log("\nALL REMEDIATION ENGINE TESTS PASSED SUCCESSFULLY!");
}

runTests().catch((err) => {
  console.error("\nTEST RUN FAILED:", err);
  process.exit(1);
});
