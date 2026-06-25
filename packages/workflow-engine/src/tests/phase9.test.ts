import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { discoverWebhookContracts } from "../webhookDiscovery.js";
import { StatefulWorkflowPlanner } from "../statefulPlanner.js";
import { EndpointContract } from "@opspilot/schemas";

export async function runPhase9Tests() {
  console.log("=== Running Phase 9 Webhook Automation Tests ===");

  const tempRoot = path.join(os.tmpdir(), `opspilot-webhook-test-${Date.now()}`);
  await fs.promises.mkdir(tempRoot, { recursive: true });

  try {
    // ----------------------------------------------------
    // Test 1: Discover Webhook Contracts from Mock Files
    // ----------------------------------------------------
    console.log("Testing Webhook Contract Discovery...");

    // Mock Next.js app router file for Stripe webhook
    const mockStripeFile = path.join(tempRoot, "src/app/api/webhooks/stripe/route.ts");
    await fs.promises.mkdir(path.dirname(mockStripeFile), { recursive: true });
    await fs.promises.writeFile(mockStripeFile, `
      import stripe from "stripe";
      
      export async function POST(req: Request) {
        const sig = req.headers.get("stripe-signature");
        const event = stripe.webhooks.constructEvent(
          await req.text(),
          sig,
          process.env.STRIPE_WEBHOOK_SECRET
        );
        return new Response(JSON.stringify({ received: true }));
      }
    `);

    // Mock Express router file for GitHub webhook
    const mockGithubFile = path.join(tempRoot, "routes/github.ts");
    await fs.promises.mkdir(path.dirname(mockGithubFile), { recursive: true });
    await fs.promises.writeFile(mockGithubFile, `
      import express from "express";
      const router = express.Router();
      
      router.post("/webhooks/github", (req, res) => {
        const sig = req.headers["x-hub-signature-256"];
        const secret = process.env.GITHUB_SECRET;
        res.status(200).json({ ok: true });
      });
      
      export default router;
    `);

    const contracts = await discoverWebhookContracts(tempRoot);

    assert.strictEqual(contracts.length, 2, "Expected 2 webhook contracts discovered");

    const stripeContract = contracts.find(c => c.provider === "stripe");
    assert.ok(stripeContract, "Expected Stripe webhook contract discovered");
    assert.strictEqual(stripeContract.type, "incoming");
    assert.strictEqual(stripeContract.endpointUrl, "/api/webhooks/stripe");
    assert.strictEqual(stripeContract.signingSecretEnvVar, "STRIPE_WEBHOOK_SECRET");
    assert.ok(stripeContract.eventTypes.includes("payment_intent.succeeded"));

    const githubContract = contracts.find(c => c.provider === "github");
    assert.ok(githubContract, "Expected GitHub webhook contract discovered");
    assert.strictEqual(githubContract.type, "incoming");
    assert.strictEqual(githubContract.endpointUrl, "/webhooks/github");
    assert.strictEqual(githubContract.signingSecretEnvVar, "GITHUB_SECRET");
    assert.ok(githubContract.eventTypes.includes("push"));

    console.log("✓ Webhook Contract Discovery verified.");

    // ----------------------------------------------------
    // Test 2: Cross-Protocol Planning (HTTP + Webhook)
    // ----------------------------------------------------
    console.log("Testing Cross-Protocol Webhook Planning...");

    const mockHttpContract: EndpointContract = {
      id: "post-api-orders",
      method: "POST",
      path: "/api/orders",
      framework: "express" as const,
      source: { file: "orders.ts", line: 10 },
      summary: "Create Order API",
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
    const plan = await planner.planWorkflow("proj-123", [mockHttpContract], [], [stripeContract]);

    const steps = plan.steps;

    // We expect:
    // 1. Create order HTTP Step
    // 2. Simulate Webhook Step (linked to order creation lifecycle)
    const createStep = steps.find(s => s.type === "HTTP_REQUEST" && s.name.includes("Create Order"));
    assert.ok(createStep, "Expected HTTP create step generated");

    const webhookStep = steps.find(s => s.type === "SIMULATE_WEBHOOK");
    assert.ok(webhookStep, "Expected Simulate Webhook step generated");
    assert.strictEqual(webhookStep.config.provider, "stripe");
    assert.strictEqual(webhookStep.config.endpointUrl, "${baseApiUrl}/api/webhooks/stripe");
    assert.strictEqual(webhookStep.config.payload.data.object.id, "${orders.id}", "Expected dynamic payload binding linked to orders.id");

    console.log("✓ Cross-Protocol Webhook Planning verified.");

  } finally {
    // Cleanup temp directory
    await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }

  console.log("✓ All Phase 9 Webhook Automation Tests Passed!");
}
