/**
 * Phase 14 — Telemetry & Incidents E2E Integration Test
 *
 * Prerequisites:
 *   1. Start telemetry-api  (port 4005)
 *   2. Start incident-worker (port 4006)
 *   3. Start control-api    (port 4000)
 *   4. Run: npx tsx apps/telemetry-api/src/tests/run.ts
 */

import assert from "node:assert";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";

// Load environment variables before database prisma import
const rootEnv = path.resolve(process.cwd(), ".env");
const parentEnv = path.resolve(process.cwd(), "../../.env");
if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv });
} else if (fs.existsSync(parentEnv)) {
  dotenv.config({ path: parentEnv });
}

import { prisma } from "@opspilot/database";
import { config, generateId } from "@opspilot/shared";

const TELEMETRY_URL = "http://localhost:4005";
const INCIDENT_WORKER_URL = "http://localhost:4006";
const CONTROL_API_URL = "http://localhost:4000";

async function waitForService(url: string, label: string, maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await fetch(url);
      return;
    } catch {
      console.log(`  Waiting for ${label} at ${url}... (${i + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`Service ${label} at ${url} did not become available`);
}

async function runTests() {
  console.log("=== Running Telemetry & Incidents E2E Tests ===\n");

  // Verify services are running
  console.log("Checking service availability...");
  await waitForService(`${TELEMETRY_URL}/v1/metrics`, "Telemetry API");
  await waitForService(`${INCIDENT_WORKER_URL}/evaluate`, "Incident Worker");
  console.log("✓ All services are reachable.\n");

  // 1. Setup mock database records
  const userId = `user_${generateId()}`;
  const orgId = `org_${generateId()}`;
  const projectId = `proj_${generateId()}`;

  console.log("Seeding test user, org, and project...");
  // Confirm or insert ADMIN role
  await prisma.role.upsert({
    where: { id: "ADMIN" },
    create: { id: "ADMIN", name: "Administrator" },
    update: {}
  });

  await prisma.user.create({
    data: {
      id: userId,
      email: `${userId}@opspilot.ai`,
      passwordHash: "mock_password_hash"
    }
  });

  await prisma.organization.create({
    data: {
      id: orgId,
      name: "Test Telemetry Org"
    }
  });

  await prisma.membership.create({
    data: {
      organizationId: orgId,
      userId: userId,
      roleId: "ADMIN"
    }
  });

  await prisma.project.create({
    data: {
      id: projectId,
      organizationId: orgId,
      name: "Test Telemetry Project"
    }
  });

  // Create an alert rule: CPU usage > 90
  const alertRule = await prisma.alertRule.create({
    data: {
      projectId,
      metricName: "cpu_usage",
      threshold: 90.0,
      durationMs: 60000
    }
  });
  console.log(`✓ Alert rule created: ${alertRule.id}`);

  // Generate JWT token
  const token = jwt.sign({ userId, email: `${userId}@opspilot.ai` }, config.jwtSecret);
  const authHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
    "x-organization-id": orgId,
    "x-project-id": projectId
  };

  try {
    // Clear any leftover telemetry data
    await fetch(`${TELEMETRY_URL}/v1/clear`, { method: "DELETE" });

    // 2. Ingest telemetry metric breaching threshold
    console.log("\n1. Ingesting metric data...");
    const metricIngestRes = await fetch(`${TELEMETRY_URL}/v1/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serviceId: "service-abc",
        metricName: "cpu_usage",
        value: 95.5
      })
    });
    assert.strictEqual(metricIngestRes.status, 202);
    console.log("✓ Metric ingested successfully.");

    // Give async trigger a moment
    await new Promise((r) => setTimeout(r, 500));

    // 3. Trigger alert evaluation explicitly to ensure it runs
    console.log("\n2. Evaluating alert rules...");
    const evaluateRes = await fetch(`${INCIDENT_WORKER_URL}/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    assert.strictEqual(evaluateRes.status, 200);
    const evalData: any = await evaluateRes.json();
    const dbIncidents = await prisma.incident.findMany({
      where: { title: { contains: "cpu_usage" } }
    });
    assert(dbIncidents.length > 0, "Incident should be created in DB");
    console.log(`✓ Alert evaluated. Active incidents count: ${dbIncidents.length}`);

    // 4. Query incidents list via Control API
    console.log("\n3. Querying incidents list...");
    const incidentsRes = await fetch(`${CONTROL_API_URL}/api/incidents`, {
      headers: authHeaders
    });
    assert.strictEqual(incidentsRes.status, 200);
    const incidents: any[] = await incidentsRes.json();
    assert(incidents.length > 0);
    const newIncident = incidents.find((i: any) => i.title.includes("cpu_usage"));
    assert(newIncident);
    assert.strictEqual(newIncident.status, "INVESTIGATING");
    console.log(`✓ Retrieved incident: ${newIncident.id}`);

    // 5. Add a comment to the incident
    console.log("\n4. Adding comment to incident timeline...");
    const commentRes = await fetch(`${CONTROL_API_URL}/api/incidents/${newIncident.id}/comments`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ comment: "Production CPU spike is under investigation." })
    });
    assert.strictEqual(commentRes.status, 201);
    console.log("✓ Comment added.");

    // 6. Query timeline events
    console.log("\n5. Querying incident timeline...");
    const timelineRes = await fetch(`${CONTROL_API_URL}/api/incidents/${newIncident.id}/timeline`, {
      headers: authHeaders
    });
    assert.strictEqual(timelineRes.status, 200);
    const timeline: any[] = await timelineRes.json();
    assert(timeline.length >= 3); // METRIC_BREACH, AGENT_TRIGGERED, COMMENT
    assert(timeline.some((e: any) => e.type === "COMMENT" && e.message.includes("under investigation")));
    console.log("✓ Timeline verified.");

    // 7. Manually trigger investigation
    console.log("\n6. Manually triggering investigation...");
    // Reset status to PENDING first
    await prisma.incident.update({
      where: { id: newIncident.id },
      data: { status: "PENDING" }
    });
    const investigateRes = await fetch(`${CONTROL_API_URL}/api/incidents/${newIncident.id}/investigate`, {
      method: "POST",
      headers: authHeaders
    });
    assert.strictEqual(investigateRes.status, 200);
    const investigateData: any = await investigateRes.json();
    assert.strictEqual(investigateData.incident.status, "INVESTIGATING");
    console.log("✓ Manual investigation trigger verified.");

    // 8. Test deduplication — ingest the same breach metric again
    console.log("\n7. Testing incident deduplication...");
    await fetch(`${TELEMETRY_URL}/v1/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serviceId: "service-abc",
        metricName: "cpu_usage",
        value: 97.0
      })
    });
    const evalRes2 = await fetch(`${INCIDENT_WORKER_URL}/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const evalData2: any = await evalRes2.json();
    assert.strictEqual(evalData2.created, 0); // Should deduplicate, not create new
    console.log("✓ Deduplication verified — no new incident created for repeat breach.");

    // 9. Verify the repeat breach event was added to the existing timeline
    console.log("\n8. Verifying deduplication event on timeline...");
    const timelineRes2 = await fetch(`${CONTROL_API_URL}/api/incidents/${newIncident.id}/timeline`, {
      headers: authHeaders
    });
    const timeline2: any[] = await timelineRes2.json();
    assert(timeline2.some((e: any) => e.type === "METRIC_BREACH_REPEAT"));
    console.log("✓ Repeat breach timeline event verified.");

    // 10. Test other telemetry endpoints
    console.log("\n9. Testing log, trace, and event ingestion...");
    const logRes = await fetch(`${TELEMETRY_URL}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serviceId: "service-abc",
        message: "Error: connection timeout to database",
        level: "error"
      })
    });
    assert.strictEqual(logRes.status, 202);

    const traceRes = await fetch(`${TELEMETRY_URL}/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serviceId: "service-abc",
        traceId: "trace-001",
        spanId: "span-001",
        name: "POST /api/checkout",
        exception: "TimeoutError: operation timed out"
      })
    });
    assert.strictEqual(traceRes.status, 202);

    const eventRes = await fetch(`${TELEMETRY_URL}/v1/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serviceId: "service-abc",
        type: "deployment",
        message: "Deployed v2.1.3 to production"
      })
    });
    assert.strictEqual(eventRes.status, 202);
    console.log("✓ Log, trace, and event ingestion all successful.");

    // 11. Verify all telemetry data can be queried
    console.log("\n10. Verifying telemetry query endpoints...");
    const logsQuery = await fetch(`${TELEMETRY_URL}/v1/logs`);
    const logs: any[] = await logsQuery.json();
    assert(logs.length > 0);

    const tracesQuery = await fetch(`${TELEMETRY_URL}/v1/traces`);
    const traces: any[] = await tracesQuery.json();
    assert(traces.length > 0);

    const eventsQuery = await fetch(`${TELEMETRY_URL}/v1/events`);
    const events: any[] = await eventsQuery.json();
    assert(events.length > 0);
    console.log("✓ All telemetry query endpoints working.");

    console.log("\n========================================================");
    console.log("  ALL TELEMETRY & INCIDENTS E2E TESTS PASSED ✅");
    console.log("========================================================");
  } finally {
    // Cleanup mock records
    console.log("\nCleaning up test database records...");
    try {
      const dbIncidents = await prisma.incident.findMany({
        where: { title: { contains: "cpu_usage" } },
        select: { id: true }
      });
      const incidentIds = dbIncidents.map((i) => i.id);
      await prisma.incidentEvent.deleteMany({ where: { incidentId: { in: incidentIds } } }).catch(() => {});
      await prisma.incidentService.deleteMany({ where: { incidentId: { in: incidentIds } } }).catch(() => {});
      await prisma.incident.deleteMany({ where: { id: { in: incidentIds } } }).catch(() => {});
    } catch (e) {
      console.warn("Incident cleanup failed:", e);
    }
    await prisma.alertRule.delete({ where: { id: alertRule.id } }).catch(() => {});
    await prisma.project.delete({ where: { id: projectId } }).catch(() => {});
    await prisma.membership.deleteMany({ where: { userId } }).catch(() => {});
    await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    console.log("✓ Cleanup finished.");
  }
}

runTests().catch((err) => {
  console.error("\nTEST RUN FAILED:", err);
  process.exit(1);
});
