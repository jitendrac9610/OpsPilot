import assert from "node:assert";
import { prisma } from "@opspilot/database";
import { DiagnosticRunOrchestrator } from "../diagnosticOrchestrator.js";

export async function runPhase7Tests() {
  console.log("=== Running Phase 7 Sandbox Hardening and Operational Tests ===");

  // Create a clean org, project, repo
  const org = await prisma.organization.create({
    data: { name: "Phase 7 Test Org" }
  });
  const project = await prisma.project.create({
    data: { organizationId: org.id, name: "Phase 7 Project" }
  });
  const repo = await prisma.repository.create({
    data: { projectId: project.id, name: "phase7-repo", gitUrl: "mock-url", branch: "main" }
  });

  // Mock global fetch for sandbox controller and other endpoints
  const originalFetch = globalThis.fetch;
  let fetchCalls: Array<{ url: string; method?: string; body?: any }> = [];

  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    const method = init?.method || "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    fetchCalls.push({ url: urlStr, method, body });

    // Mock response for GET /services (initially return active, or empty for recovery tests)
    if (urlStr.includes("/services")) {
      if (urlStr.includes("inactive-sandbox")) {
        return new Response(JSON.stringify({ success: true, services: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        success: true,
        services: [{ id: "api", name: "api", kind: "api", port: 4000, endpoints: [{ externalUrl: "http://localhost:4000" }] }]
      }), { status: 200 });
    }

    // Mock response for POST /run (self-healing recovery)
    if (urlStr.endsWith("/run")) {
      return new Response(JSON.stringify({
        success: true,
        endpoints: [{ kind: "api", externalUrl: "http://localhost:4000" }],
        services: [{ id: "api", name: "api", status: "RUNNING" }]
      }), { status: 200 });
    }

    // Mock response for DELETE /api/sandboxes/:id
    if (method === "DELETE" && urlStr.includes("/api/sandboxes/")) {
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }

    // Mock webhook-worker check
    if (urlStr.includes("/webhooks/github")) {
      // Seed a snapshot first so the poller doesn't hang
      const snapshot = await prisma.repositorySnapshot.create({
        data: {
          repositoryId: repo.id,
          commitSha: "mock_sha",
          archiveUrl: "mock_archive"
        }
      });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }

    // Default mock response
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }) as typeof fetch;

  try {
    // ----------------------------------------------------
    // Test 1: Midway Cancellation
    // ----------------------------------------------------
    console.log("Testing midway cancellation check...");
    const run1 = await prisma.diagnosticRun.create({
      data: {
        repositoryId: repo.id,
        status: "CANCELLED",
        stage: "DISCOVERING",
        artifacts: { sandboxId: "cancelled-sandbox-123" }
      }
    });

    const orchestrator1 = new DiagnosticRunOrchestrator(run1.id);
    await orchestrator1.run();

    // Verify sandbox cleanup was called
    const hasCleanupCall = fetchCalls.some(c => c.method === "DELETE" && c.url.includes("cancelled-sandbox-123"));
    assert.ok(hasCleanupCall, "Expected sandbox cleanup to be called when run is cancelled midway");
    console.log("✓ Midway cancellation cleaned up sandbox resources.");

    // ----------------------------------------------------
    // Test 2: Self-healing Recovery on Resume (Success)
    // ----------------------------------------------------
    console.log("Testing self-healing recovery when services are down...");
    fetchCalls = [];
    const run2 = await prisma.diagnosticRun.create({
      data: {
        repositoryId: repo.id,
        status: "RUNNING",
        stage: "BOOTSTRAP_AUTH",
        artifacts: {
          sandboxId: "inactive-sandbox",
          baseApiUrl: "http://localhost:3000",
          sandboxStartedAt: new Date(Date.now() - (5 * 60 * 1000 - 10000)).toISOString() // slightly less than 5 mins
        }
      }
    });

    // Run orchestrator. It checks recovery, updates baseApiUrl, then since it's mock it will fail the BOOTSTRAP_AUTH stage
    // and trigger fail(), which in turn records usage metrics of 5 minutes.
    const orchestrator2 = new DiagnosticRunOrchestrator(run2.id);
    await orchestrator2.run();

    // Verify GET /services was called to check status
    const hasServicesCheck = fetchCalls.some(c => c.url.includes("/api/sandboxes/inactive-sandbox/services"));
    assert.ok(hasServicesCheck, "Expected services check to be called on resume");

    // Verify POST /run was called to recover services
    const hasRecoverCall = fetchCalls.some(c => c.method === "POST" && c.url.includes("/api/sandboxes/inactive-sandbox/run"));
    assert.ok(hasRecoverCall, "Expected services startup run endpoint to be called when inactive services detected");
    console.log("✓ Self-healing successfully restarted inactive sandbox services.");

    // ----------------------------------------------------
    // Test 3: Usage minutes metering
    // ----------------------------------------------------
    console.log("Testing usage metering...");
    // Let's query usage records for this org
    const usageRecords = await prisma.usageRecord.findMany({
      where: { orgId: org.id, dimension: "sandbox_minutes" }
    });
    assert.ok(usageRecords.length > 0, "Expected usage record to be created for the run");
    assert.strictEqual(usageRecords[0].quantity, 5, `Expected 5 usage minutes, got ${usageRecords[0].quantity}`);
    console.log("✓ Usage record successfully metered and stored in DB.");

  } finally {
    // Restore fetch
    globalThis.fetch = originalFetch;

    // Clean up DB
    await prisma.usageRecord.deleteMany({ where: { orgId: org.id } }).catch(() => {});
    await prisma.diagnosticRun.deleteMany({ where: { repositoryId: repo.id } }).catch(() => {});
    await prisma.repositorySnapshot.deleteMany({ where: { repositoryId: repo.id } }).catch(() => {});
    await prisma.repository.delete({ where: { id: repo.id } }).catch(() => {});
    await prisma.project.delete({ where: { id: project.id } }).catch(() => {});
    await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  }

  console.log("✓ All Phase 7 Sandbox Hardening and Operational Tests Passed!");
}
