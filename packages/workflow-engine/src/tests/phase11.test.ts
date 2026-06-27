import assert from "node:assert";
import { getAffectedTables, runDatabaseCleanup } from "../workflowTypes.js";
import { EndpointContract } from "@opspilot/schemas";

export async function runPhase11Tests() {
  console.log("=== Running Phase 11 Database Invariant Generation Tests ===");

  // ----------------------------------------------------
  // Test 1: Dynamic Affected Database Table Discovery
  // ----------------------------------------------------
  console.log("Testing Dynamic Table Discovery...");

  const mockContracts: EndpointContract[] = [
    {
      id: "create-order",
      method: "POST",
      path: "/api/orders",
      framework: "express" as const,
      source: { file: "orders.ts", line: 10 },
      summary: "Create Order API",
      tags: [],
      parameters: [],
      responses: [],
      security: [],
      middleware: [],
      requiredEnvironment: [],
      roles: [],
      permissions: [],
      prisma: [
        { model: "Order", operation: "create", relations: [], source: "orders.ts" }
      ],
      evidence: [],
      confidence: 1.0
    },
    {
      id: "get-profile",
      method: "GET",
      path: "/api/profiles/:id",
      framework: "express" as const,
      source: { file: "profiles.ts", line: 20 },
      summary: "Get Profile",
      tags: [],
      parameters: [],
      responses: [],
      security: [],
      middleware: [],
      requiredEnvironment: [],
      roles: [],
      permissions: [],
      prisma: [], // Empty: should fall back to path parsing ("profiles")
      evidence: [],
      confidence: 1.0
    }
  ];

  const mockPlan = {
    steps: [
      {
        id: "step-1",
        name: "Create Order",
        type: "HTTP_REQUEST" as const,
        config: { contractId: "create-order" },
        assertions: []
      },
      {
        id: "step-2",
        name: "Get Profile",
        type: "HTTP_REQUEST" as const,
        config: { contractId: "get-profile" },
        assertions: []
      }
    ]
  };

  const affected = getAffectedTables(mockPlan, mockContracts);

  assert.strictEqual(affected.length, 2, "Expected 2 affected tables discovered");
  assert.ok(affected.includes("Order"), "Expected 'Order' in affected tables (from prisma requirement)");
  assert.ok(affected.includes("profiles"), "Expected 'profiles' in affected tables (from path fallback)");

  console.log("✓ Dynamic Table Discovery verified.");

  // ----------------------------------------------------
  // Test 2: Safe Database Cleanup using lifecycle variables
  // ----------------------------------------------------
  console.log("Testing Safe Database Cleanups...");

  const cleanupsCalled: Array<{ table: string; whereClause: any }> = [];
  const mockAssertionEngine = {
    assertDBState: async (config: any) => {
      if (config.action === "cleanup") {
        cleanupsCalled.push({ table: config.table, whereClause: config.whereClause });
      }
      return { success: true, log: "Mock cleanup success" };
    }
  };

  const mockVariables = {
    "orders.id": "order_xyz123",
    "profiles.id": "profile_abc456"
  };

  await runDatabaseCleanup(mockAssertionEngine, ["Order", "profiles"], mockVariables);

  assert.strictEqual(cleanupsCalled.length, 2, "Expected 2 cleanup actions executed");
  
  const orderCleanup = cleanupsCalled.find(c => c.table === "Order");
  assert.ok(orderCleanup, "Expected Order cleanup action executed");
  assert.strictEqual(orderCleanup.whereClause.id, "order_xyz123");

  const profileCleanup = cleanupsCalled.find(c => c.table === "profiles");
  assert.ok(profileCleanup, "Expected profiles cleanup action executed");
  assert.strictEqual(profileCleanup.whereClause.id, "profile_abc456");

  console.log("✓ Safe Database Cleanups verified.");

  console.log("✓ All Phase 11 Database Invariant Generation Tests Passed!");
}
