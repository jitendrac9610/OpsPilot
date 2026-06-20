import fs from "fs";
import path from "path";
import { runStaticAnalysis } from "../staticAnalysis.js";

let failed = false;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`  ✗ FAILED: ${message}`);
    failed = true;
  } else {
    console.log(`  ✓ PASSED: ${message}`);
  }
}

async function runTests() {
  console.log("Starting Static Analysis & Audit Unit Tests...\n");

  const seededRepoPath = "c:/Users/jiten/OpsPilot/benchmarks/seeded-repo";

  // Write a mock deployment.yaml temporarily to test Kubernetes rules
  const mockYamlPath = path.join(seededRepoPath, "deployment.yaml");
  const mockYamlContent = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: test-deployment
spec:
  template:
    spec:
      containers:
        - name: test-app
          image: test-image
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /health/ready
              port: 8081
`;

  try {
    fs.writeFileSync(mockYamlPath, mockYamlContent, "utf-8");
  } catch (err) {
    console.warn("Failed to create temporary deployment.yaml for testing:", err);
  }

  // 1. Run static analysis on seeded repo
  console.log("Scanning seeded benchmark repository...");
  const findings = await runStaticAnalysis(seededRepoPath, "seeded_repo");

  // Cleanup temporary file
  try {
    if (fs.existsSync(mockYamlPath)) {
      fs.unlinkSync(mockYamlPath);
    }
  } catch {}

  console.log(`Found ${findings.length} static findings.`);

  // 2. Validate detections
  assert(findings.length > 0, "Should detect multiple findings in the seeded repository");

  // Inngest Event Mismatch
  const inngestMatch = findings.find(f => f.title.includes("Inngest") || f.description.includes("interviews.created"));
  assert(!!inngestMatch, "Should detect Inngest event name mismatch (interview.created vs interviews.created)");

  // BullMQ Queue Mismatch
  const queueMatch = findings.find(f => f.title.includes("BullMQ") || f.description.includes("interviews-queue"));
  assert(!!queueMatch, "Should detect BullMQ queue name mismatch (interview-queue vs interviews-queue)");

  // Redis Hostname Mismatch
  const redisMatch = findings.find(f => f.title.includes("Redis") && f.description.includes("redis-invalid-hostname"));
  assert(!!redisMatch, "Should detect Redis hostname mismatch due to misspelled env variable");

  // PostgreSQL Connection Leak
  const postgresLeak = findings.find(f => f.title.includes("PostgreSQL") || f.description.includes("release()"));
  assert(!!postgresLeak, "Should detect PostgreSQL client connection leak (missing client.release())");

  // MongoDB Missing Index
  const mongoIndex = findings.find(f => f.title.includes("MongoDB") || f.description.includes("roomName"));
  assert(!!mongoIndex, "Should detect MongoDB missing index on roomName field");

  // Stripe Raw Body Webhook Issue
  const stripeWebhook = findings.find(f => f.title.includes("Stripe") || f.description.includes("req.body"));
  assert(!!stripeWebhook, "Should detect Stripe raw-body webhook signature verification failure");

  // Clerk Bearer Token Parse Issue
  const clerkToken = findings.find(f => f.title.includes("Clerk") || f.description.includes("Bearer"));
  assert(!!clerkToken, "Should detect Clerk token verification Bearer parsing error");

  // GetStream Token Mismatch
  const getStreamMismatch = findings.find(f => f.title.includes("GetStream") || f.description.includes("normalized user ID"));
  assert(!!getStreamMismatch, "Should detect GetStream token user ID identity mismatch");

  // Kubernetes Probe Port Mismatch
  const k8sProbe = findings.find(f => f.title.includes("Kubernetes") && f.description.includes("8081"));
  assert(!!k8sProbe, "Should detect Kubernetes readiness probe port mismatch (8081 vs 8080)");

  // Memory Leak Risk
  const oomRisk = findings.find(f => f.title.includes("memory leak") || f.description.includes("leakMemoryArray"));
  assert(!!oomRisk, "Should detect memory leak / array append allocation risk");

  // ----------------------------------------------------
  // Finish
  // ----------------------------------------------------
  if (failed) {
    console.error("\nSome static analysis tests FAILED.");
    process.exit(1);
  } else {
    console.log("\nAll Static Analysis & Audit Unit Tests PASSED successfully! (10/10)");
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error("Test execution crashed:", err);
  process.exit(1);
});
