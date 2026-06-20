import assert from "node:assert";
import { ApprovalManager } from "../approval.js";
import { PRManager } from "../pr.js";
import { AuditLogger } from "../audit.js";
import { RollbackManager } from "../rollback.js";

async function runTests() {
  console.log("=== Running Approval and Git Unit Tests ===");

  const am = new ApprovalManager(true); 
  const pm = new PRManager(true);
  const al = new AuditLogger(true);
  const rm = new RollbackManager(true);

  console.log("\n1. Testing Approval Requests...");
  const requestId = await am.createApprovalRequest("plan-123", "agent-system");
  assert(requestId.startsWith("appr-"));

  const approveRes = await am.approveRequest(requestId, "jiten", "PR_MERGE");
  assert.strictEqual(approveRes.success, true);
  assert(approveRes.approvedActionId?.startsWith("act-"));
  console.log("✓ Approval card status workflow passed.");

  console.log("\n2. Testing PR Creation...");
  const prInfo = await pm.createPR(approveRes.approvedActionId!, "opspilot-fix-abc");
  assert.strictEqual(prInfo.success, true);
  assert(prInfo.prId.startsWith("pr-"));
  assert(prInfo.url.includes("demo-repo/pull"));
  assert(prInfo.number >= 100);
  console.log("✓ PR created and registered.");

  console.log("\n3. Testing Audit Logging...");
  const auditId = await al.log("org-abc", "user-jiten", "PR_APPROVED", { prNumber: prInfo.number });
  assert(auditId.startsWith("audit-"));
  console.log("✓ Audit log saved.");

  console.log("\n4. Testing Recovery & Rollbacks...");
  const monitorId = await rm.startRecoveryMonitor(approveRes.approvedActionId!);
  assert(monitorId.startsWith("mon-"));

  const rollbackRes = await rm.triggerRollback(monitorId, "Application HTTP 500 error spike detected");
  assert.strictEqual(rollbackRes.success, true);
  assert(rollbackRes.rollbackId.startsWith("rb-"));
  console.log("✓ Rollback triggered successfully.");

  console.log("\nALL APPROVAL AND GIT TESTS PASSED SUCCESSFULLY!");
}

runTests().catch((err) => {
  console.error("\nTEST RUN FAILED:", err);
  process.exit(1);
});
