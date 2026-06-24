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
      branch: "main"
    }
  });

  const repositoryId2 = "888888";
  await prisma.repository.create({
    data: {
      id: repositoryId2,
      projectId: project.id,
      name: "webhook-test-repo-2",
      gitUrl: "mock-repo-url-2",
      branch: "main"
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
        "x-hub-signature-256": `sha256=${sig3}`
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
        "x-hub-signature-256": `sha256=${sig4}`
      },
      body: body4
    });
    assert.strictEqual(res4.status, 200);
    const data4 = await res4.json() as any;
    assert.strictEqual(data4.status, "installation_created_processed");

    // Verify DB
    const installRecord = await prisma.gitHubInstallation.findUnique({
      where: { repositoryId }
    });
    assert.ok(installRecord);
    assert.strictEqual(installRecord.installationId, "123456");

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
        "x-hub-signature-256": `sha256=${sig7}`
      },
      body: body7
    });
    assert.strictEqual(res7.status, 200);
    const data7 = await res7.json() as any;
    assert.strictEqual(data7.status, "repositories_added_processed");

    // Verify DB
    const installRecord2 = await prisma.gitHubInstallation.findUnique({
      where: { repositoryId: repositoryId2 }
    });
    assert.ok(installRecord2);
    assert.strictEqual(installRecord2.installationId, "123456");

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
        "x-hub-signature-256": `sha256=${sig8}`
      },
      body: body8
    });
    assert.strictEqual(res8.status, 200);
    const data8 = await res8.json() as any;
    assert.strictEqual(data8.status, "repositories_removed_processed");

    // Verify DB removal
    const removedRecord = await prisma.gitHubInstallation.findUnique({
      where: { repositoryId: repositoryId2 }
    });
    assert.ok(!removedRecord);

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
        "x-hub-signature-256": `sha256=${sig9}`
      },
      body: body9
    });
    assert.strictEqual(res9.status, 200);
    const data9 = await res9.json() as any;
    assert.strictEqual(data9.status, "installation_deleted_processed");

    // Verify DB removal of remaining installations
    const deletedRecord = await prisma.gitHubInstallation.findUnique({
      where: { repositoryId }
    });
    assert.ok(!deletedRecord);

    // Verify AuditLog
    const auditDeleted = await prisma.auditLog.findFirst({
      where: { orgId: org.id, action: "github.installation.deleted" }
    });
    assert.ok(auditDeleted);
    console.log("✓ Processed installation.deleted successfully");

  } finally {
    // Cleanup Database
    console.log("\nCleaning up database resources...");
    await prisma.gitHubInstallation.deleteMany({
      where: { repositoryId: { in: [repositoryId, repositoryId2] } }
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
    await redis.del("github-webhook:delivery:delivery-unique-999");
    
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
