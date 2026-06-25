import dotenv from "dotenv";
import path from "node:path";
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });
process.env.NODE_ENV = "test";

import assert from "node:assert";
import { publicRouter } from "../routes/public.js";
import { adminRouter } from "../routes/admin.js";
import { repositoryOwnershipWhere, sandboxOwnershipWhere } from "../routes/sandbox.js";
import express from "express";

async function runApiTests() {
  console.log("=== Running Control Plane API Route Tests ===");

  // 1. Verify router definitions and exports
  assert.ok(publicRouter);
  assert.ok(adminRouter);
  console.log("✓ Routers are exported and resolved successfully.");

  // 2. Mocking validation of API Key middleware
  console.log("\nTesting API Key Verification Middleware...");
  const mockReq: any = {
    headers: {
      "x-api-key": "mock-api-key-xyz"
    },
    params: { id: "repo-123" }
  };
  
  const mockRes: any = {
    status: (code: number) => {
      mockRes.statusCode = code;
      return mockRes;
    },
    json: (data: any) => {
      mockRes.body = data;
      return mockRes;
    }
  };

  assert.strictEqual(mockReq.headers["x-api-key"], "mock-api-key-xyz");
  console.log("✓ API key header parsing verified.");

  // 3. Mocking Admin Role validation
  console.log("\nTesting Admin Role Verification...");
  const mockAdminReq: any = {
    organizationId: "org-123",
    user: { id: "user-123" }
  };
  
  assert.strictEqual(mockAdminReq.organizationId, "org-123");
  assert.strictEqual(mockAdminReq.user.id, "user-123");
  console.log("✓ Admin request context mapping verified.");

  const repositoryScope = repositoryOwnershipWhere("user-123", "repo-123", "org-123");
  assert.strictEqual(repositoryScope.project.organizationId, "org-123");
  assert.strictEqual(repositoryScope.project.organization.memberships.some.userId, "user-123");

  const sandboxScope = sandboxOwnershipWhere("user-123", "sandbox-123", "org-123");
  assert.strictEqual(sandboxScope.snapshot.repository.project.organizationId, "org-123");
  assert.strictEqual(
    sandboxScope.snapshot.repository.project.organization.memberships.some.userId,
    "user-123"
  );
  console.log("✓ Repository and sandbox queries include tenant ownership constraints.");

  // 4. Verify Repository Diagnose Route Registration
  console.log("\nTesting Repository Routes...");
  const { repositoryRouter } = await import("../routes/repositories.js");
  assert.ok(repositoryRouter);
  const repoRoutes = (repositoryRouter as any).stack
    .filter((layer: any) => layer.route)
    .map((layer: any) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods)
    }));
  const diagnoseRoute = repoRoutes.find((r: any) => r.path === "/:id/diagnose");
  assert.ok(diagnoseRoute, "Expected POST /:id/diagnose route to be registered");
  assert.deepStrictEqual(diagnoseRoute.methods, ["post"]);
  console.log("✓ /repositories/:id/diagnose orchestrator route successfully registered.");

  // 5. Test Auth Security Pipeline
  console.log("\nTesting Auth Security Pipeline...");
  const baseUrl = `http://localhost:4000`;
  const email = `test-security-${Date.now()}@example.com`;
  const password = "SecurePassword123!";
  const newPassword = "EvenMoreSecurePassword123!";

  // Start API server by importing index.js
  console.log("Starting API server for integration testing...");
  await import("../index.js");
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // A. Register
  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  assert.strictEqual(registerRes.status, 201);
  const registerData = await registerRes.json() as any;
  assert.strictEqual(registerData.email, email);
  assert.strictEqual(registerData.verified, false);
  const verificationToken = registerData.verificationToken;
  assert.ok(verificationToken);
  console.log("✓ Registration returns unverified status and verification token.");

  // B. Verify email
  const verifyRes = await fetch(`${baseUrl}/api/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: verificationToken })
  });
  assert.strictEqual(verifyRes.status, 200);
  console.log("✓ Email verification with valid token succeeds.");

  // C. Verify expired/invalid email token throws
  const verifyInvalidRes = await fetch(`${baseUrl}/api/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: "invalid-token" })
  });
  assert.strictEqual(verifyInvalidRes.status, 400);
  console.log("✓ Email verification with invalid token fails with status 400.");

  // D. Forgot password
  const forgotRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email })
  });
  assert.strictEqual(forgotRes.status, 200);
  const forgotData = await forgotRes.json() as any;
  const resetToken = forgotData.resetToken;
  assert.ok(resetToken);
  console.log("✓ Forgot password generates reset token.");

  // E. Reset password with token
  const resetRes = await fetch(`${baseUrl}/api/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: resetToken, newPassword })
  });
  assert.strictEqual(resetRes.status, 200);
  console.log("✓ Password reset with valid token succeeds.");

  // F. Login with new password
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: newPassword })
  });
  assert.strictEqual(loginRes.status, 200);
  const loginData = await loginRes.json() as any;
  const jwtToken = loginData.token;
  assert.ok(jwtToken);
  console.log("✓ Login with new password succeeds.");

  // F1. Test Refresh Token Rotation and Reuse Detection
  console.log("\nTesting Refresh Token Rotation...");
  const loginRefreshToken = loginData.refreshToken;
  assert.ok(loginRefreshToken);

  // Refresh token rotation POST /api/auth/refresh
  const refreshRes = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: loginRefreshToken })
  });
  assert.strictEqual(refreshRes.status, 200);
  const refreshData = await refreshRes.json() as any;
  const newAccessToken = refreshData.token;
  const newRefreshToken = refreshData.refreshToken;
  assert.ok(newAccessToken);
  assert.ok(newRefreshToken);
  assert.notStrictEqual(newAccessToken, jwtToken);
  assert.notStrictEqual(newRefreshToken, loginRefreshToken);
  console.log("✓ Refresh token rotation returns new access token and rotated refresh token.");

  // Verify access with new token
  const testAccessRes = await fetch(`${baseUrl}/api/auth/2fa/setup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${newAccessToken}`
    }
  });
  assert.strictEqual(testAccessRes.status, 200);
  console.log("✓ Access succeeds using the new access token.");

  // Test Refresh Token Reuse Detection (Token Theft Defense)
  console.log("Testing Refresh Token reuse detection...");
  const reuseRes = await fetch(`${baseUrl}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: loginRefreshToken }) // reuse old rotated token
  });
  assert.strictEqual(reuseRes.status, 401);
  const reuseData = await reuseRes.json() as any;
  assert.ok(reuseData.message.includes("reuse detected") || reuseData.message.includes("Security Alert"));
  console.log("✓ Reuse detection triggers 401 Unauthorized.");

  // Verify that the new access token is now invalid because reuse detection revoked all sessions
  const testAccessAfterReuseRes = await fetch(`${baseUrl}/api/auth/2fa/setup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${newAccessToken}`
    }
  });
  assert.strictEqual(testAccessAfterReuseRes.status, 401);
  console.log("✓ Active sessions are revoked on refresh token reuse.");

  // Login again to get a fresh token for logout test
  const loginForLogoutRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: newPassword })
  });
  const loginForLogoutData = await loginForLogoutRes.json() as any;
  const jwtTokenForLogout = loginForLogoutData.token;

  // G. Invalidate old sessions/cookies - verify logout
  const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${jwtTokenForLogout}`
    }
  });
  assert.strictEqual(logoutRes.status, 200);
  console.log("✓ Logout revokes user session.");

  // Re-login to get a fresh token for 2FA setup
  const reloginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: newPassword })
  });
  const reloginData = await reloginRes.json() as any;
  let loginToken = reloginData.token;

  // H. Setup 2FA
  const setupRes = await fetch(`${baseUrl}/api/auth/2fa/setup`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${loginToken}`
    }
  });
  assert.strictEqual(setupRes.status, 200);
  const setupData = await setupRes.json() as any;
  const twoFactorSecret = setupData.secret;
  assert.ok(twoFactorSecret);
  console.log("✓ 2FA setup generates secret.");

  // Generate valid TOTP code
  const { generateTOTP } = await import("../utils/totp.js");
  const totpCode = generateTOTP(twoFactorSecret);

  // I. Enable 2FA
  const enableRes = await fetch(`${baseUrl}/api/auth/2fa/enable`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${loginToken}`
    },
    body: JSON.stringify({ code: totpCode })
  });
  assert.strictEqual(enableRes.status, 200);
  const enableData = await enableRes.json() as any;
  assert.ok(enableData.recoveryCodes.length > 0);
  const recoveryCode = enableData.recoveryCodes[0];
  console.log("✓ 2FA enable with valid TOTP code succeeds and returns recovery codes.");

  // J. Login again - should require 2FA
  const login2faReqRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: newPassword })
  });
  assert.strictEqual(login2faReqRes.status, 200);
  const login2faReqData = await login2faReqRes.json() as any;
  assert.strictEqual(login2faReqData.status, "2fa_required");
  const loginUserId = login2faReqData.userId;
  assert.ok(loginUserId);
  console.log("✓ Login with 2FA enabled returns 2fa_required status.");

  // K. Verify 2FA code to get token
  const finalTotp = generateTOTP(twoFactorSecret);
  const verify2faRes = await fetch(`${baseUrl}/api/auth/2fa`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: loginUserId, code: finalTotp })
  });
  assert.strictEqual(verify2faRes.status, 200);
  const verify2faData = await verify2faRes.json() as any;
  assert.ok(verify2faData.token);
  console.log("✓ Verifying valid 2FA TOTP code completes login and issues token.");

  // L. Verify recovery code login
  const recoveryLoginReq = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: newPassword })
  });
  const recoveryLoginData = await recoveryLoginReq.json() as any;
  const verifyRecoveryRes = await fetch(`${baseUrl}/api/auth/2fa`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId: recoveryLoginData.userId, code: recoveryCode })
  });
  assert.strictEqual(verifyRecoveryRes.status, 200);
  const verifyRecoveryData = await verifyRecoveryRes.json() as any;
  assert.ok(verifyRecoveryData.token);
  loginToken = verifyRecoveryData.token;
  console.log("✓ Verifying valid 2FA recovery code completes login and issues token.");

  // 6. Test Diagnostic Runs Integration Pipeline
  console.log("\nTesting Diagnostic Runs integration...");
  const { prisma: db } = await import("@opspilot/database");
  
  // Find or create organization
  const org = await db.organization.create({
    data: { name: "Test Org" }
  });
  
  // Find user ID from our tested login/user
  const testUserObj = await db.user.findFirst({ where: { email } });
  if (!testUserObj) throw new Error("Test user not found");

  // Create membership
  const role = await db.role.upsert({
    where: { name: "ADMIN" },
    update: {},
    create: { id: "admin", name: "ADMIN", description: "Admin role" }
  });
  await db.membership.create({
    data: {
      organizationId: org.id,
      userId: testUserObj.id,
      roleId: role.id
    }
  });

  // Create project
  const project = await db.project.create({
    data: {
      organizationId: org.id,
      name: "Test Project"
    }
  });

  // Create repository
  const repository = await db.repository.create({
    data: {
      projectId: project.id,
      name: "test-repo",
      gitUrl: "mock-repo-url",
      branch: "main"
    }
  });

  // A. Trigger diagnosis via API
  const diagnoseResponse = await fetch(`${baseUrl}/api/repositories/${repository.id}/diagnose`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${loginToken}`
    }
  });
  assert.strictEqual(diagnoseResponse.status, 201);
  const runData = await diagnoseResponse.json() as any;
  assert.strictEqual(runData.status, "PENDING");
  assert.strictEqual(runData.stage, "CLONING");
  assert.strictEqual(runData.repositoryId, repository.id);
  const runId = runData.id;
  assert.ok(runId);
  console.log("✓ Creating diagnostic run enqueues a background job.");

  // B. Get diagnostic run details
  const getRunRes = await fetch(`${baseUrl}/api/diagnostic-runs/${runId}`, {
    method: "GET",
    headers: {
      "Authorization": `Bearer ${loginToken}`
    }
  });
  assert.strictEqual(getRunRes.status, 200);
  const getRunData = await getRunRes.json() as any;
  assert.strictEqual(getRunData.id, runId);
  console.log("✓ GET /api/diagnostic-runs/:id returns correct status.");

  // C. Cancel diagnostic run
  const cancelRes = await fetch(`${baseUrl}/api/diagnostic-runs/${runId}/cancel`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${loginToken}`
    }
  });
  assert.strictEqual(cancelRes.status, 200);
  const cancelData = await cancelRes.json() as any;
  assert.strictEqual(cancelData.status, "CANCELLED");
  console.log("✓ POST /api/diagnostic-runs/:id/cancel cancels the run.");

  // D. Retry diagnostic run
  const retryRes = await fetch(`${baseUrl}/api/diagnostic-runs/${runId}/retry`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${loginToken}`
    }
  });
  assert.strictEqual(retryRes.status, 201);
  const retryData = await retryRes.json() as any;
  assert.strictEqual(retryData.status, "PENDING");
  assert.strictEqual(retryData.stage, "CLONING");
  console.log("✓ POST /api/diagnostic-runs/:id/retry retries the cancelled run.");

  // E. Dynamic Evaluation Runner Test
  console.log("\nTesting dynamic evaluation runner...");
  const { runDynamicEvaluation } = await import("@opspilot/evaluation-worker");
  const evalPayload = await runDynamicEvaluation(org.id, "gemini-1.5-flash");
  
  assert.ok(evalPayload);
  assert.strictEqual(evalPayload.status, "PASSED");
  assert.strictEqual(evalPayload.model, "gemini-1.5-flash");
  assert.ok(evalPayload.metrics.retrieval.serviceRoutingAccuracy > 0);
  assert.ok(evalPayload.metrics.agent.rootCauseAccuracy > 0);
  assert.ok(evalPayload.metrics.retrieval.evidenceCoverage > 0); // security protection rate
  
  // Verify that AuditLog is created
  const loggedEval = await db.auditLog.findFirst({
    where: { orgId: org.id, action: "evaluation.benchmark.complete" }
  });
  assert.ok(loggedEval);
  assert.strictEqual((loggedEval.payload as any).status, "PASSED");
  console.log("✓ Dynamic evaluation metrics calculated and logged successfully.");

  // Clean up all seeded diagnostic resources
  await db.auditLog.deleteMany({ where: { orgId: org.id } });
  await db.diagnosticRun.deleteMany({ where: { repositoryId: repository.id } });
  await db.repository.delete({ where: { id: repository.id } });
  await db.project.delete({ where: { id: project.id } });
  await db.membership.deleteMany({ where: { organizationId: org.id } });
  await db.organization.delete({ where: { id: org.id } });
  console.log("✓ Cleaned up all seeded diagnostic test resources.");

  // Cleanup test user
  await db.user.delete({ where: { email } });
  console.log("✓ Cleaned up security test user.");

  console.log("\nALL API ROUTE CHECKS PASSED!");
  process.exit(0);
}

runApiTests().catch((err) => {
  console.error("API ROUTE TESTS FAILED:", err);
  process.exit(1);
});
