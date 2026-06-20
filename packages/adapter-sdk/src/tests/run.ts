import assert from "node:assert";
import fs from "fs";
import path from "path";
import { AdapterRegistry } from "../registry.js";
import "../index.js"; // trigger registration

const TEMP_TEST_DIR = path.resolve("c:/Users/jiten/OpsPilot", "sandbox", "temp_adapter_tests");

async function setupMockRepo() {
  if (fs.existsSync(TEMP_TEST_DIR)) {
    fs.rmSync(TEMP_TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEMP_TEST_DIR, { recursive: true });
}

async function cleanupMockRepo() {
  if (fs.existsSync(TEMP_TEST_DIR)) {
    fs.rmSync(TEMP_TEST_DIR, { recursive: true, force: true });
  }
}

async function runTests() {
  console.log("=== Running Adapter SDK Unit Tests ===");

  const adapters = AdapterRegistry.getAdapters();
  console.log(`Registered adapters count: ${adapters.length}`);
  assert(adapters.length >= 15, "Expected at least 15 registered adapters");

  await setupMockRepo();

  try {
    // 1. Test MongoDB Adapter
    console.log("\nTesting MongoDB Adapter...");
    const mongoAdapter = adapters.find(a => a.id === "mongodb")!;
    assert(mongoAdapter);
    
    // Test negative
    let detectRes = await mongoAdapter.detect(["src/index.ts"], TEMP_TEST_DIR);
    assert.strictEqual(detectRes.detected, false);

    // Test positive (package.json)
    const mongoPj = "package.json";
    fs.writeFileSync(path.join(TEMP_TEST_DIR, mongoPj), JSON.stringify({
      dependencies: { mongoose: "^8.0.0" }
    }));
    detectRes = await mongoAdapter.detect([mongoPj], TEMP_TEST_DIR);
    assert.strictEqual(detectRes.detected, true);
    assert.strictEqual(detectRes.version, "^8.0.0");
    assert(detectRes.reasons[0].includes("Mongoose"));

    let arch = await mongoAdapter.contributeArchitecture(TEMP_TEST_DIR);
    assert(arch.nodes.some(n => n.id === "db:mongodb" && n.type === "database"));
    console.log("✓ MongoDB Adapter passed.");

    // 2. Test PostgreSQL Adapter
    console.log("\nTesting PostgreSQL Adapter...");
    const pgAdapter = adapters.find(a => a.id === "postgres")!;
    assert(pgAdapter);

    // Test positive (prisma schema)
    detectRes = await pgAdapter.detect(["schema.prisma"], TEMP_TEST_DIR);
    assert.strictEqual(detectRes.detected, true);
    assert(detectRes.reasons[0].includes("Prisma schema"));

    arch = await pgAdapter.contributeArchitecture(TEMP_TEST_DIR);
    assert(arch.nodes.some(n => n.id === "db:postgres" && n.type === "database"));
    console.log("✓ PostgreSQL Adapter passed.");

    // 3. Test Redis Adapter
    console.log("\nTesting Redis Adapter...");
    const redisAdapter = adapters.find(a => a.id === "redis")!;
    assert(redisAdapter);

    // Test positive (package.json)
    const redisPj = "subapp/package.json";
    fs.mkdirSync(path.join(TEMP_TEST_DIR, "subapp"), { recursive: true });
    fs.writeFileSync(path.join(TEMP_TEST_DIR, redisPj), JSON.stringify({
      dependencies: { ioredis: "^5.3.0" }
    }));
    detectRes = await redisAdapter.detect([redisPj], TEMP_TEST_DIR);
    assert.strictEqual(detectRes.detected, true);
    assert.strictEqual(detectRes.version, "^5.3.0");

    arch = await redisAdapter.contributeArchitecture(TEMP_TEST_DIR);
    assert(arch.nodes.some(n => n.id === "cache:redis" && n.type === "cache"));
    console.log("✓ Redis Adapter passed.");

    // 4. Test BullMQ Adapter
    console.log("\nTesting BullMQ Adapter...");
    const bullAdapter = adapters.find(a => a.id === "bullmq")!;
    assert(bullAdapter);

    // Test positive
    const bullPj = "package.json";
    fs.writeFileSync(path.join(TEMP_TEST_DIR, bullPj), JSON.stringify({
      dependencies: { bullmq: "^5.8.0" }
    }));
    detectRes = await bullAdapter.detect([bullPj], TEMP_TEST_DIR);
    assert.strictEqual(detectRes.detected, true);
    assert.strictEqual(detectRes.version, "^5.8.0");

    arch = await bullAdapter.contributeArchitecture(TEMP_TEST_DIR);
    assert(arch.nodes.some(n => n.id === "queue:bullmq" && n.type === "queue/topic/event"));
    assert(arch.edges.some(e => e.source === "queue:bullmq" && e.target === "cache:redis"));
    console.log("✓ BullMQ Adapter passed.");

    // 5. Test Inngest Adapter
    console.log("\nTesting Inngest Adapter...");
    const inngestAdapter = adapters.find(a => a.id === "inngest")!;
    assert(inngestAdapter);

    // Test positive (config file)
    detectRes = await inngestAdapter.detect(["inngest.json"], TEMP_TEST_DIR);
    assert.strictEqual(detectRes.detected, true);

    arch = await inngestAdapter.contributeArchitecture(TEMP_TEST_DIR);
    assert(arch.nodes.some(n => n.id === "integration:inngest" && n.type === "external SDK"));
    console.log("✓ Inngest Adapter passed.");

    // 6. Test Clerk Adapter
    console.log("\nTesting Clerk Adapter...");
    const clerkAdapter = adapters.find(a => a.id === "clerk")!;
    assert(clerkAdapter);

    // Test positive (.env)
    const envFile = ".env";
    fs.writeFileSync(path.join(TEMP_TEST_DIR, envFile), "CLERK_SECRET_KEY=sk_test_foo\n");
    detectRes = await clerkAdapter.detect([envFile], TEMP_TEST_DIR);
    assert.strictEqual(detectRes.detected, true);

    arch = await clerkAdapter.contributeArchitecture(TEMP_TEST_DIR);
    assert(arch.nodes.some(n => n.id === "integration:clerk" && n.type === "external SDK"));
    console.log("✓ Clerk Adapter passed.");

    // 7. Test Stripe Adapter
    console.log("\nTesting Stripe Adapter...");
    const stripeAdapter = adapters.find(a => a.id === "stripe")!;
    assert(stripeAdapter);

    // Test positive (.env)
    fs.writeFileSync(path.join(TEMP_TEST_DIR, envFile), "STRIPE_SECRET_KEY=sk_test_bar\n");
    detectRes = await stripeAdapter.detect([envFile], TEMP_TEST_DIR);
    assert.strictEqual(detectRes.detected, true);

    arch = await stripeAdapter.contributeArchitecture(TEMP_TEST_DIR);
    assert(arch.nodes.some(n => n.id === "integration:stripe" && n.type === "external SDK"));
    console.log("✓ Stripe Adapter passed.");

    // 8. Test GetStream Adapter
    console.log("\nTesting GetStream Adapter...");
    const streamAdapter = adapters.find(a => a.id === "getstream")!;
    assert(streamAdapter);

    // Test positive (package.json)
    const streamPj = "package.json";
    fs.writeFileSync(path.join(TEMP_TEST_DIR, streamPj), JSON.stringify({
      dependencies: { "stream-chat": "^8.2.0" }
    }));
    detectRes = await streamAdapter.detect([streamPj], TEMP_TEST_DIR);
    assert.strictEqual(detectRes.detected, true);
    assert.strictEqual(detectRes.version, "^8.2.0");

    arch = await streamAdapter.contributeArchitecture(TEMP_TEST_DIR);
    assert(arch.nodes.some(n => n.id === "integration:getstream" && n.type === "external SDK"));
    console.log("✓ GetStream Adapter passed.");

    // 9. Test Docker Adapter
    console.log("\nTesting Docker Adapter...");
    const dockerAdapter = adapters.find(a => a.id === "docker")!;
    assert(dockerAdapter);

    // Test positive
    detectRes = await dockerAdapter.detect(["docker-compose.yml"], TEMP_TEST_DIR);
    assert.strictEqual(detectRes.detected, true);

    arch = await dockerAdapter.contributeArchitecture(TEMP_TEST_DIR);
    assert(arch.nodes.some(n => n.id === "deployment:docker" && n.type === "Docker container"));
    console.log("✓ Docker Adapter passed.");

    // 10. Test Kubernetes Adapter
    console.log("\nTesting Kubernetes Adapter...");
    const k8sAdapter = adapters.find(a => a.id === "kubernetes")!;
    assert(k8sAdapter);

    // Test positive
    detectRes = await k8sAdapter.detect(["k8s/deployment.yaml"], TEMP_TEST_DIR);
    assert.strictEqual(detectRes.detected, true);

    arch = await k8sAdapter.contributeArchitecture(TEMP_TEST_DIR);
    assert(arch.nodes.some(n => n.id === "deployment:kubernetes" && n.type === "Kubernetes resource"));
    console.log("✓ Kubernetes Adapter passed.");

    console.log("\nALL DEEP ADAPTER TESTS PASSED SUCCESSFULLY!");
  } finally {
    await cleanupMockRepo();
  }
}

runTests().catch(err => {
  console.error("\nTEST RUN FAILED:", err);
  process.exit(1);
});
