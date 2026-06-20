import { prisma } from "@opspilot/database";
import { getLocalEmbedding, getEmbedding } from "../utils/llm.js";
import { CodeStore } from "../store/code.js";
import { GraphStore } from "../store/graph.js";
import { RuntimeStore } from "../store/runtime.js";
import { DocsStore } from "../store/docs.js";
import { IncidentStore } from "../store/incident.js";
import { ProjectStore } from "../store/project.js";
import { RAGPipeline } from "../pipeline.js";

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
  console.log("Starting RAG & Knowledge Systems Unit Tests...\n");

  // ----------------------------------------------------
  // Test 1: Local Hashing Vectorizer
  // ----------------------------------------------------
  console.log("Running Local Hashing Vectorizer Tests...");
  const vector1 = getLocalEmbedding("const x = 5;");
  assert(vector1.length === 128, "Embedding dimension should be 128");

  // L2 Norm check
  const magnitude = Math.sqrt(vector1.reduce((sum, val) => sum + val * val, 0));
  assert(Math.abs(magnitude - 1.0) < 1e-5, "Vector should be L2 normalized to magnitude of 1.0");

  const vector2 = getLocalEmbedding("const x = 5;");
  assert(
    vector1.every((val, idx) => val === vector2[idx]),
    "Vector generation should be completely deterministic"
  );

  const vector3 = getLocalEmbedding("different text content");
  assert(
    !vector1.every((val, idx) => val === vector3[idx]),
    "Different text should generate different vectors"
  );

  // ----------------------------------------------------
  // Test 2: Gemini Embedding Fallback
  // ----------------------------------------------------
  console.log("\nRunning Gemini API Fallback Tests...");
  // Should transparently fallback to local vectorizer if key is missing/empty
  const fallbackVector = await getEmbedding("test fallback");
  assert(fallbackVector.length === 128, "Fallback vector should be 128 dimensions");

  // ----------------------------------------------------
  // Test 3: Code Store Hybrid Search & BM25
  // ----------------------------------------------------
  console.log("\nRunning Code RAG Store Tests...");

  // Mock Prisma methods
  const mockFile = { id: "file_1", path: "src/index.ts" };
  const mockChunks = [
    { id: "chunk_1", fileId: "file_1", content: "function handlePayment() { return stripe.charge(); }", startLine: 1, endLine: 5 },
    { id: "chunk_2", fileId: "file_1", content: "function handleDatabase() { return prisma.user.findMany(); }", startLine: 6, endLine: 10 },
  ];
  const mockEmbeddings = [
    { id: "emb_1", chunkId: "chunk_1", embedding: JSON.stringify(getLocalEmbedding(mockChunks[0].content)) },
    { id: "emb_2", chunkId: "chunk_2", embedding: JSON.stringify(getLocalEmbedding(mockChunks[1].content)) },
  ];

  (prisma as any).repositoryFile = {
    findMany: async () => [mockFile]
  };
  (prisma as any).codeChunk = {
    findMany: async (args: any) => {
      if (args?.where?.fileId) return mockChunks;
      if (args?.where?.content?.contains) {
        return mockChunks.filter(c => c.content.toLowerCase().includes(args.where.content.contains.toLowerCase()));
      }
      return mockChunks;
    }
  };
  (prisma as any).chunkEmbedding = {
    findMany: async () => mockEmbeddings
  };

  const codeStore = new CodeStore();
  const searchResults = await codeStore.searchCode("stripe payment", { snapshotId: "snap_1", limit: 5 });
  
  assert(searchResults.length > 0, "Should return matching code chunks");
  assert(searchResults[0].id === "chunk_1", "BM25/Vector hybrid should rank payment chunk higher for query 'stripe payment'");

  // Exact matching tests
  (prisma as any).symbol = {
    findMany: async () => [
      { id: "sym_1", fileId: "file_1", name: "handlePayment", kind: "function", line: 2 }
    ]
  };

  const exactResults = await codeStore.searchExact("handlePayment", "stripe.charge", "snap_1");
  assert(exactResults.length > 0, "Should return exact matches by symbol and error substring");
  assert(exactResults.some(r => r.id === "chunk_1"), "Exact search should locate payment chunk");

  // ----------------------------------------------------
  // Test 4: GraphRAG Store
  // ----------------------------------------------------
  console.log("\nRunning GraphRAG Store Tests...");

  (prisma as any).architectureVersion = {
    findFirst: async () => ({ id: "arch_v1", snapshotId: "snap_1" })
  };
  (prisma as any).graphNode = {
    findMany: async () => [
      { id: "svc_payment", versionId: "arch_v1", type: "service", name: "payment-service", metadata: {} },
      { id: "infra_postgres", versionId: "arch_v1", type: "database", name: "PostgreSQL Database", metadata: {} },
    ]
  };
  (prisma as any).graphEdge = {
    findMany: async () => [
      { id: "edge_1", versionId: "arch_v1", source: "svc_payment", target: "infra_postgres", type: "QUERIES", evidence: JSON.stringify({ file: "src/db.ts", line: 12, description: "Queries postgres db" }) }
    ]
  };

  const graphStore = new GraphStore();
  const graphResults = await graphStore.searchGraph("payment database", { snapshotId: "snap_1" });
  assert(graphResults !== null, "Graph results should not be null");
  assert(graphResults!.nodes.length === 2, "Graph traversal should return 2 connected nodes");
  assert(graphResults!.pathsSummary.includes("payment-service"), "Paths summary should mention payment-service");

  // ----------------------------------------------------
  // Test 5: Runtime Telemetry RAG Store
  // ----------------------------------------------------
  console.log("\nRunning Runtime RAG Store Tests...");

  (prisma as any).workflowStepRun = {
    findMany: async () => [
      { id: "step_run_1", workflowRunId: "run_1", stepId: "step_1", status: "FAILED", logs: ["stripe authentication error", "payment failed"], error: "Payment auth failed" }
    ]
  };
  (prisma as any).failureBoundary = {
    findMany: async () => [
      { id: "fb_1", workflowRunId: "run_1", failedStage: "stripe_charge", reason: "Authentication failure" }
    ]
  };

  const runtimeStore = new RuntimeStore();
  const runtimeResults = await runtimeStore.searchRuntime("auth", { workflowRunId: "run_1" });
  assert(runtimeResults.stepRuns.length === 1, "Should retrieve failed step run");
  assert(runtimeResults.telemetrySummary.includes("Payment auth failed"), "Telemetry summary should contain error message");

  // ----------------------------------------------------
  // Test 6: Docs, Incident & Project Stores
  // ----------------------------------------------------
  console.log("\nRunning Docs, Incident & Project RAG Stores Tests...");

  (prisma as any).documentationSource = {
    findMany: async () => [
      { id: "doc_1", name: "Stripe API SDK Documentation", version: "v3", url: "https://stripe.com/docs", content: "Stripe.charges.create requires API key authorization." }
    ]
  };
  const docsStore = new DocsStore();
  const docsResults = await docsStore.searchDocs("stripe charges", {});
  assert(docsResults.documents.length === 1, "Should retrieve documentation record");

  (prisma as any).postmortem = {
    findMany: async () => [
      { id: "pm_1", incidentId: "inc_1", summary: "Stripe connection failed due to empty secret.", rootCause: "Missing STRIPE_SECRET_KEY env var.", timeline: "{}", actions: "[]" }
    ]
  };
  (prisma as any).incident = {
    findUnique: async () => ({ id: "inc_1", title: "Stripe Outage", severity: "HIGH", status: "RESOLVED" })
  };
  const incidentStore = new IncidentStore();
  const incidentResults = await incidentStore.searchIncidents("stripe secret", {});
  assert(incidentResults.postmortems.length === 1, "Should retrieve past postmortem matching query");

  (prisma as any).memoryRecord = {
    findMany: async () => [
      { id: "mem_1", agentRunId: "run_1", type: "project", content: { title: "Payment Runbook", description: "Always rotate Stripe webhook secrets monthly." } }
    ]
  };
  const projectStore = new ProjectStore();
  const projectResults = await projectStore.searchProjectKnowledge("runbook", {});
  assert(projectResults.memories.length === 1, "Should retrieve team runbooks from memory records");

  // ----------------------------------------------------
  // Test 7: RAG Pipeline Integration
  // ----------------------------------------------------
  console.log("\nRunning RAG Pipeline Integration Tests...");

  (prisma as any).retrievalRound = {
    create: async () => ({ id: "round_1" })
  };
  (prisma as any).retrievalCandidate = {
    create: async () => ({})
  };
  (prisma as any).retrievalQualityAssessment = {
    create: async () => ({})
  };

  const pipeline = new RAGPipeline();
  const pipelineContext = await pipeline.retrieveHybridContext("stripe secret payment issue", {
    snapshotId: "snap_1",
    workflowRunId: "run_1",
    incidentId: "inc_1",
    skipRewrite: true
  });

  assert(pipelineContext.objective === "stripe secret payment issue", "Objective should match rewrote/original query");
  assert(pipelineContext.codeChunks.length > 0, "Aggregated context should contain code chunks");
  assert(pipelineContext.graphResult !== null, "Aggregated context should contain GraphRAG data");
  assert(pipelineContext.qualityAssessment.assessment === "SUFFICIENT", "Assessment gate should evaluate context as SUFFICIENT");

  // ----------------------------------------------------
  // Finish
  // ----------------------------------------------------
  if (failed) {
    console.error("\nSome unit tests FAILED. Review errors above.");
    process.exit(1);
  } else {
    console.log("\nAll RAG & Knowledge Systems Unit Tests PASSED successfully! (7/7)");
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error("Test execution crashed:", err);
  process.exit(1);
});
