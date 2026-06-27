import dotenv from "dotenv";
import path from "node:path";
import assert from "node:assert";
import crypto from "crypto";

// Load environment variables from the workspace root .env file
dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

// Set test environment variables before importing app
process.env.NODE_ENV = "test";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret";

const PORT = 4099;

async function runWebhookTests() {
  console.log("=== Running GitHub Webhook Receiver Tests ===");

  // Dynamically import index.js after env variables are set
  const { app, redis } = await import("../index.js");

  // Start express app on test port
  const testServer = app.listen(PORT, () => {
    console.log(`Test server listening on port ${PORT}`);
  });

  const { prisma } = await import("@opspilot/database");

  // Find or create test organization
  const org = await prisma.organization.create({
    data: { name: "Webhook Test Org" }
  });

  // Create project
  const project = await prisma.project.create({
    data: {
      organizationId: org.id,
      name: "Webhook Test Project"
    }
  });

  // Create repositories
  const repositoryId = "999999";
  await prisma.repository.create({
    data: {
      id: repositoryId,
      projectId: project.id,
      name: "webhook-test-repo",
      gitUrl: "mock-repo-url",
      branch: "main",
      githubRepositoryId: repositoryId
    }
  });

  const repositoryId2 = "888888";
  await prisma.repository.create({
    data: {
      id: repositoryId2,
      projectId: project.id,
      name: "webhook-test-repo-2",
      gitUrl: "mock-repo-url-2",
      branch: "main",
      githubRepositoryId: repositoryId2
    }
  });

  try {
    // 1. Missing signature
    console.log("\n1. Testing missing signature rejection...");
    const res1 = await fetch(`http://localhost:${PORT}/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push"
      },
      body: JSON.stringify({ repository: { id: 999999 } })
    });
    assert.strictEqual(res1.status, 401);
    const data1 = await res1.json() as any;
    assert.strictEqual(data1.error, "UNAUTHORIZED");
    console.log("✓ Successfully rejected missing signature");

    // 2. Invalid signature
    console.log("\n2. Testing invalid signature rejection...");
    const res2 = await fetch(`http://localhost:${PORT}/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": "sha256=invalid-signature-value"
      },
      body: JSON.stringify({ repository: { id: 999999 } })
    });
    assert.strictEqual(res2.status, 401);
    const data2 = await res2.json() as any;
    assert.strictEqual(data2.error, "UNAUTHORIZED");
    console.log("✓ Successfully rejected invalid signature");

    // 3. Reject push when repository installation scope mismatch (no installation in DB yet)
    console.log("\n3. Testing repository installation scope check (mismatch)...");
    const payload3 = {
      repository: { id: 999999, clone_url: "mock-repo-url" },
      installation: { id: 123456 },
      ref: "refs/heads/main",
      head_commit: { id: "test-commit-sha-1" }
    };
    const body3 = JSON.stringify(payload3);
    const sig3 = crypto.createHmac("sha256", "test-webhook-secret").update(body3).digest("hex");

    const res3 = await fetch(`http://localhost:${PORT}/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": `sha256=${sig3}`,
        "x-github-delivery": "delivery-unique-3"
      },
      body: body3
    });
    assert.strictEqual(res3.status, 403);
    const data3 = await res3.json() as any;
    assert.strictEqual(data3.error, "UNAUTHORIZED_INSTALLATION");
    console.log("✓ Successfully rejected push due to missing installation scope in DB");

    // 4. Handle installation.created event
    console.log("\n4. Testing installation.created lifecycle hook...");
    const payload4 = {
      action: "created",
      installation: { id: 123456 },
      repositories: [
        { id: 999999, name: "webhook-test-repo" }
      ]
    };
    const body4 = JSON.stringify(payload4);
    const sig4 = crypto.createHmac("sha256", "test-webhook-secret").update(body4).digest("hex");

    const res4 = await fetch(`http://localhost:${PORT}/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "installation",
        "x-hub-signature-256": `sha256=${sig4}`,
        "x-github-delivery": "delivery-unique-4"
      },
      body: body4
    });
    assert.strictEqual(res4.status, 200);
    const data4 = await res4.json() as any;
    assert.strictEqual(data4.status, "installation_created_processed");

    // Verify DB
    const installRecord = await prisma.gitHubInstallation.findUnique({
      where: { installationId: "123456" },
      include: { repositories: true }
    });
    assert.ok(installRecord);
    assert.strictEqual(installRecord.installationId, "123456");
    assert.ok(installRecord.repositories.some(repo => repo.id === repositoryId));

    // Verify AuditLog
    const auditCreated = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: "github.installation.created" }
    });
    assert.ok(auditCreated);
    assert.strictEqual((auditCreated.payload as any).installationId, "123456");
    console.log("✓ Processed installation.created successfully");

    // 5. Accept push when scope/installation matches
    console.log("\n5. Testing push event with matching installation scope...");
    const payload5 = {
      repository: { id: 999999, clone_url: "mock-repo-url" },
      installation: { id: 123456 },
      ref: "refs/heads/main",
      head_commit: { id: "test-commit-sha-2" }
    };
    const body5 = JSON.stringify(payload5);
    const sig5 = crypto.createHmac("sha256", "test-webhook-secret").update(body5).digest("hex");

    const res5 = await fetch(`http://localhost:${PORT}/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": `sha256=${sig5}`,
        "x-github-delivery": "delivery-unique-999"
      },
      body: body5
    });
    assert.strictEqual(res5.status, 202);
    const data5 = await res5.json() as any;
    assert.strictEqual(data5.status, "processing_snapshot");
    console.log("✓ Successfully processed push event with matching scope");

    // 6. Redis Deduplication
    console.log("\n6. Testing Redis deduplication on X-GitHub-Delivery...");
    const res6 = await fetch(`http://localhost:${PORT}/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": `sha256=${sig5}`,
        "x-github-delivery": "delivery-unique-999"
      },
      body: body5
    });
    assert.strictEqual(res6.status, 200);
    const data6 = await res6.json() as any;
    assert.strictEqual(data6.status, "ignored_duplicate");
    console.log("✓ Successfully ignored duplicate delivery ID");

    // 7. Handle installation_repositories.added event
    console.log("\n7. Testing installation_repositories.added lifecycle hook...");
    const payload7 = {
      action: "added",
      installation: { id: 123456 },
      repositories_added: [
        { id: 888888, name: "webhook-test-repo-2" }
      ]
    };
    const body7 = JSON.stringify(payload7);
    const sig7 = crypto.createHmac("sha256", "test-webhook-secret").update(body7).digest("hex");

    const res7 = await fetch(`http://localhost:${PORT}/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "installation_repositories",
        "x-hub-signature-256": `sha256=${sig7}`,
        "x-github-delivery": "delivery-unique-7"
      },
      body: body7
    });
    assert.strictEqual(res7.status, 200);
    const data7 = await res7.json() as any;
    assert.strictEqual(data7.status, "repositories_added_processed");

    // Verify DB
    const installRecord2 = await prisma.gitHubInstallation.findUnique({
      where: { installationId: "123456" },
      include: { repositories: true }
    });
    assert.ok(installRecord2);
    assert.strictEqual(installRecord2.installationId, "123456");
    assert.ok(installRecord2.repositories.some(repo => repo.id === repositoryId2));

    // Verify AuditLog
    const auditAdded = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: "github.installation.repository_added" }
    });
    assert.ok(auditAdded);
    assert.strictEqual((auditAdded.payload as any).repositoryId, "888888");
    console.log("✓ Processed installation_repositories.added successfully");

    // 8. Handle installation_repositories.removed event
    console.log("\n8. Testing installation_repositories.removed lifecycle hook...");
    const payload8 = {
      action: "removed",
      installation: { id: 123456 },
      repositories_removed: [
        { id: 888888, name: "webhook-test-repo-2" }
      ]
    };
    const body8 = JSON.stringify(payload8);
    const sig8 = crypto.createHmac("sha256", "test-webhook-secret").update(body8).digest("hex");

    const res8 = await fetch(`http://localhost:${PORT}/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "installation_repositories",
        "x-hub-signature-256": `sha256=${sig8}`,
        "x-github-delivery": "delivery-unique-8"
      },
      body: body8
    });
    assert.strictEqual(res8.status, 200);
    const data8 = await res8.json() as any;
    assert.strictEqual(data8.status, "repositories_removed_processed");

    // Verify DB removal
    const removedRecord = await prisma.repository.findUnique({
      where: { id: repositoryId2 }
    });
    assert.ok(!removedRecord?.githubInstallationId);

    // Verify AuditLog
    const auditRemoved = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: "github.installation.repository_removed" }
    });
    assert.ok(auditRemoved);
    assert.strictEqual((auditRemoved.payload as any).repositoryId, "888888");
    console.log("✓ Processed installation_repositories.removed successfully");

    // 9. Handle installation.deleted event
    console.log("\n9. Testing installation.deleted lifecycle hook...");
    const payload9 = {
      action: "deleted",
      installation: { id: 123456 }
    };
    const body9 = JSON.stringify(payload9);
    const sig9 = crypto.createHmac("sha256", "test-webhook-secret").update(body9).digest("hex");

    const res9 = await fetch(`http://localhost:${PORT}/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "installation",
        "x-hub-signature-256": `sha256=${sig9}`,
        "x-github-delivery": "delivery-unique-9"
      },
      body: body9
    });
    assert.strictEqual(res9.status, 200);
    const data9 = await res9.json() as any;
    assert.strictEqual(data9.status, "installation_deleted_processed");

    // Verify DB removal of remaining installations
    const deletedRecord = await prisma.gitHubInstallation.findUnique({
      where: { installationId: "123456" }
    });
    assert.ok(!deletedRecord);

    // Verify AuditLog
    const auditDeleted = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: "github.installation.deleted" }
    });
    assert.ok(auditDeleted);
    console.log("✓ Processed installation.deleted successfully");

    // 10. Missing X-GitHub-Delivery rejection
    console.log("\n10. Testing missing X-GitHub-Delivery rejection...");
    const payload10 = {
      repository: { id: 999999, clone_url: "mock-repo-url" },
      installation: { id: 123456 },
      ref: "refs/heads/main",
      head_commit: { id: "test-commit-sha-10" }
    };
    const body10 = JSON.stringify(payload10);
    const sig10 = crypto.createHmac("sha256", "test-webhook-secret").update(body10).digest("hex");
    const res10 = await fetch(`http://localhost:${PORT}/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": `sha256=${sig10}`
        // no x-github-delivery
      },
      body: body10
    });
    assert.strictEqual(res10.status, 400);
    const data10 = await res10.json() as any;
    assert.strictEqual(data10.error, "BAD_REQUEST");
    assert.ok(data10.message.includes("delivery"));
    console.log("✓ Successfully rejected push due to missing X-GitHub-Delivery");

    // 11. Branch deletion push event handling
    console.log("\n11. Testing branch deletion push event handling...");
    const payload11 = {
      repository: { id: 999999 },
      deleted: true,
      ref: "refs/heads/feature-branch"
    };
    const body11 = JSON.stringify(payload11);
    const sig11 = crypto.createHmac("sha256", "test-webhook-secret").update(body11).digest("hex");
    const res11 = await fetch(`http://localhost:${PORT}/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push",
        "x-hub-signature-256": `sha256=${sig11}`,
        "x-github-delivery": "delivery-unique-11"
      },
      body: body11
    });
    assert.strictEqual(res11.status, 200);
    const data11 = await res11.json() as any;
    assert.strictEqual(data11.status, "branch_deleted");
    // Verify AuditLog
    const auditBranchDeleted = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: "github.branch.deleted" }
    });
    assert.ok(auditBranchDeleted);
    assert.strictEqual((auditBranchDeleted.payload as any).branch, "feature-branch");
    console.log("✓ Branch deletion handled and audited successfully");

    // 12. Handle installation.suspend event
    console.log("\n12. Testing installation.suspend lifecycle hook...");
    // Let's first create the installation mapping again
    const manualInstallation = await prisma.gitHubInstallation.create({
      data: {
        organizationId: org.id,
        installationId: "123456",
        accountLogin: "webhook-test",
        accountType: "Organization",
        permissions: {}
      }
    });
    await prisma.repository.update({
      where: { id: repositoryId },
      data: { githubInstallationId: manualInstallation.id }
    });

    const payload12 = {
      action: "suspend",
      installation: { id: 123456 }
    };
    const body12 = JSON.stringify(payload12);
    const sig12 = crypto.createHmac("sha256", "test-webhook-secret").update(body12).digest("hex");
    const res12 = await fetch(`http://localhost:${PORT}/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "installation",
        "x-hub-signature-256": `sha256=${sig12}`,
        "x-github-delivery": "delivery-unique-12"
      },
      body: body12
    });
    assert.strictEqual(res12.status, 200);
    const data12 = await res12.json() as any;
    assert.strictEqual(data12.status, "installation_suspended_processed");
    // Verify DB removal
    const suspendedRecord = await prisma.gitHubInstallation.findUnique({
      where: { installationId: "123456" }
    });
    assert.ok(suspendedRecord?.suspendedAt);
    // Verify AuditLog
    const auditSuspended = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: "github.installation.suspended" }
    });
    assert.ok(auditSuspended);
    console.log("✓ Processed installation.suspend successfully");

    // 13. Handle installation.unsuspend event
    console.log("\n13. Testing installation.unsuspend lifecycle hook...");
    const payload13 = {
      action: "unsuspend",
      installation: { id: 123456 },
      repositories: [
        { id: 999999, name: "webhook-test-repo" }
      ]
    };
    const body13 = JSON.stringify(payload13);
    const sig13 = crypto.createHmac("sha256", "test-webhook-secret").update(body13).digest("hex");
    const res13 = await fetch(`http://localhost:${PORT}/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "installation",
        "x-hub-signature-256": `sha256=${sig13}`,
        "x-github-delivery": "delivery-unique-13"
      },
      body: body13
    });
    assert.strictEqual(res13.status, 200);
    const data13 = await res13.json() as any;
    assert.strictEqual(data13.status, "installation_unsuspended_processed");
    // Verify DB restore
    const unsuspendedRecord = await prisma.gitHubInstallation.findUnique({
      where: { installationId: "123456" },
      include: { repositories: true }
    });
    assert.ok(unsuspendedRecord);
    assert.strictEqual(unsuspendedRecord.installationId, "123456");
    assert.strictEqual(unsuspendedRecord.suspendedAt, null);
    assert.ok(unsuspendedRecord.repositories.some(repo => repo.id === repositoryId));
    // Verify AuditLog
    const auditUnsuspended = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: "github.installation.unsuspended" }
    });
    assert.ok(auditUnsuspended);
    console.log("✓ Processed installation.unsuspend successfully");

    // 14. Signature-based replay attack prevention
    console.log("\n14. Testing Signature-based replay protection...");
    // Let's reuse payload13 and sig13 but with a different delivery ID to try and bypass deduplication
    const res14 = await fetch(`http://localhost:${PORT}/webhooks/github`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "installation",
        "x-hub-signature-256": `sha256=${sig13}`,
        "x-github-delivery": "delivery-unique-14" // New delivery ID
      },
      body: body13
    });
    assert.strictEqual(res14.status, 200);
    const data14 = await res14.json() as any;
    assert.strictEqual(data14.status, "ignored_replay");
    console.log("✓ Successfully detected and blocked signature replay attack");

  } finally {
    // Cleanup Database
    console.log("\nCleaning up database resources...");
    await prisma.gitHubInstallation.deleteMany({
      where: { installationId: "123456" }
    });
    await prisma.auditLog.deleteMany({
      where: { orgId: org.id }
    });
    await prisma.repository.deleteMany({
      where: { id: { in: [repositoryId, repositoryId2] } }
    });
    await prisma.project.delete({
      where: { id: project.id }
    });
    await prisma.organization.delete({
      where: { id: org.id }
    });

    // Clean up Redis
    const keys = await redis.keys("github-webhook:*");
    for (const key of keys) {
      await redis.del(key);
    }
    
    // Stop server and redis
    testServer.close();
    await redis.quit();
    console.log("✓ Cleanup finished successfully.");
  }

  console.log("\nALL WEBHOOK LIFECYCLE TESTS PASSED!");
  process.exit(0);
}

runWebhookTests().catch((err) => {
  console.error("WEBHOOK LIFECYCLE TESTS FAILED:", err);
  process.exit(1);
});
