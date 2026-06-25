import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { discoverQueueContracts } from "../queueDiscovery.js";
import { StatefulWorkflowPlanner } from "../statefulPlanner.js";
import { EndpointContract } from "@opspilot/schemas";

export async function runPhase10Tests() {
  console.log("=== Running Phase 10 Queue and Worker Intelligence Tests ===");

  const tempRoot = path.join(os.tmpdir(), `opspilot-queue-test-${Date.now()}`);
  await fs.promises.mkdir(tempRoot, { recursive: true });

  try {
    // ----------------------------------------------------
    // Test 1: Discover Queue Contracts from Mock Files
    // ----------------------------------------------------
    console.log("Testing Queue Contract Discovery...");

    // Mock BullMQ file
    const mockBullFile = path.join(tempRoot, "src/jobs/refund.ts");
    await fs.promises.mkdir(path.dirname(mockBullFile), { recursive: true });
    await fs.promises.writeFile(mockBullFile, `
      import { Queue, Worker } from "bullmq";
      
      const refundQueue = new Queue("refunds");
      
      const worker = new Worker("refunds", async (job) => {
        console.log("Processing refund", job.data);
      });
    `);

    // Mock Redis Pub/Sub file
    const mockPubSubFile = path.join(tempRoot, "src/pubsub.ts");
    await fs.promises.mkdir(path.dirname(mockPubSubFile), { recursive: true });
    await fs.promises.writeFile(mockPubSubFile, `
      import Redis from "ioredis";
      const redis = new Redis();
      
      async function publishEvent(data) {
        await redis.publish("events-channel", JSON.stringify(data));
      }
      
      redis.subscribe("events-channel", (err) => {
        if (err) console.error(err);
      });
    `);

    const contracts = await discoverQueueContracts(tempRoot);

    assert.strictEqual(contracts.length, 2, "Expected 2 queue contracts discovered");

    const bullContract = contracts.find(c => c.name === "refunds");
    assert.ok(bullContract, "Expected refunds queue contract discovered");
    assert.strictEqual(bullContract.type, "bullmq");
    assert.strictEqual(bullContract.producers.length, 1);
    assert.strictEqual(bullContract.consumers.length, 1);

    const pubsubContract = contracts.find(c => c.name === "events-channel");
    assert.ok(pubsubContract, "Expected events-channel contract discovered");
    assert.strictEqual(pubsubContract.type, "redis-pubsub");
    assert.strictEqual(pubsubContract.producers.length, 1);
    assert.strictEqual(pubsubContract.consumers.length, 1);

    console.log("✓ Queue Contract Discovery verified.");

    // ----------------------------------------------------
    // Test 2: Stateful Planner Queue step injection
    // ----------------------------------------------------
    console.log("Testing Queue Stateful Workflow Planning...");

    const mockHttpContract: EndpointContract = {
      id: "post-api-refunds",
      method: "POST",
      path: "/api/refunds",
      framework: "express" as const,
      source: { file: "refunds.ts", line: 10 },
      summary: "Create Refund API",
      tags: [],
      parameters: [],
      responses: [
        {
          status: "201",
          description: "Created",
          headers: {},
          content: {
            "application/json": {
              type: "object",
              properties: {
                id: { type: "string" }
              }
            }
          }
        }
      ],
      security: [],
      middleware: [],
      requiredEnvironment: [],
      roles: [],
      permissions: [],
      prisma: [],
      evidence: [],
      confidence: 1.0
    };

    const planner = new StatefulWorkflowPlanner("http://localhost:3000");
    const plan = await planner.planWorkflow("proj-123", [mockHttpContract], [], [], [bullContract]);

    const steps = plan.steps;

    // We expect:
    // 1. Create refund HTTP Step
    // 2. Wait for Queue Job Step (linked to refund creation lifecycle via word sharing)
    const createStep = steps.find(s => s.type === "HTTP_REQUEST" && s.name.includes("Create Refund"));
    assert.ok(createStep, "Expected HTTP create step generated");

    const queueStep = steps.find(s => s.type === "WAIT_FOR_JOB");
    assert.ok(queueStep, "Expected Wait for Queue Job step generated");
    assert.strictEqual(queueStep.config.queueName, "refunds");
    assert.strictEqual(queueStep.config.state, "completed");
    assert.strictEqual(queueStep.config.payloadContains.refundId, "${refunds.id}", "Expected dynamic payload binding linked to refunds.id");

    console.log("✓ Queue Stateful Workflow Planning verified.");

  } finally {
    // Cleanup temp directory
    await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log("✓ All Phase 10 Queue and Worker Intelligence Tests Passed!");
}
