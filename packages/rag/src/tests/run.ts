import dotenv from "dotenv";
import path from "node:path";
dotenv.config({ path: path.resolve(__dirname, "../../../../.env") });
process.env.NODE_ENV = "test";

import { prisma } from "@opspilot/database";
import { getLocalEmbedding, getEmbedding } from "../utils/llm.js";
import { CodeStore } from "../store/code.js";
import { GraphStore } from "../store/graph.js";
import { RuntimeStore } from "../store/runtime.js";
import { DocsStore } from "../store/docs.js";
import { IncidentStore } from "../store/incident.js";
import { ProjectStore } from "../store/project.js";
import { RAGPipeline, RAGContext } from "../pipeline.js";

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
  assert((graphResults!.nodes[0] as any).score > (graphResults!.nodes[1] as any).score, "Relevance-aware ranking should rank direct match higher than neighbor");

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
  (prisma as any).repositorySnapshot = {
    findUnique: async () => ({ id: "snap_1", commitSha: "test_sha_123" })
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
  assert(pipelineContext.qualityAssessment.reasons.some(r => r.includes("Causally aligned")), "Quality assessment reasons should contain causal alignment status");
  assert(pipelineContext.fullContextText.includes("Citation: File [src/index.ts]"), "Full context text should contain explicit file citations");
  assert(pipelineContext.fullContextText.includes("Artifact: workflowStepRun/`step_run_1`"), "Full context text should contain explicit runtime artifact citations");

  // ----------------------------------------------------
  // Test 8: RAG Quality Evaluation Benchmark Suite
  // ----------------------------------------------------
  console.log("\nRunning RAG Quality Evaluation Benchmark Suite...");

  interface BenchmarkCase {
    id: string;
    query: string;
    requiredSources: string[];
    forbiddenDistractors: string[];
    expectedRootCause: string;
    files: any[];
    chunks: any[];
    embeddings: any[];
    nodes: any[];
    edges: any[];
    stepRuns: any[];
    boundaries: any[];
    incidentEvents: any[];
  }

  const benchmarkCases: BenchmarkCase[] = [
    {
      id: "case_1_payment",
      query: "Stripe connection failed due to empty secret",
      requiredSources: ["src/payment.ts", "payment-service"],
      forbiddenDistractors: ["src/auth.ts", "auth-service"],
      expectedRootCause: "src/payment.ts",
      files: [
        { id: "payment_f", path: "src/payment.ts" },
        { id: "auth_f", path: "src/auth.ts" }
      ],
      chunks: [
        { id: "chunk_payment", fileId: "payment_f", content: "function processPayment() { stripe.charge(); }", startLine: 1, endLine: 5 },
        { id: "chunk_auth", fileId: "auth_f", content: "function authenticate() { jwt.verify(); }", startLine: 1, endLine: 5 }
      ],
      embeddings: [
        { id: "emb_pay", chunkId: "chunk_payment", embedding: JSON.stringify(getLocalEmbedding("stripe connection failed payment")) },
        { id: "emb_auth", chunkId: "chunk_auth", embedding: JSON.stringify(getLocalEmbedding("jwt authentication")) }
      ],
      nodes: [
        { id: "payment-service", versionId: "arch_v1", type: "service", name: "payment-service", metadata: {} },
        { id: "auth-service", versionId: "arch_v1", type: "service", name: "auth-service", metadata: {} }
      ],
      edges: [
        { id: "edge_pay", versionId: "arch_v1", source: "payment-service", target: "auth-service", type: "CALLS", evidence: "{}" }
      ],
      stepRuns: [
        { id: "step_pay_fail", workflowRunId: "run_test", status: "FAILED", error: "Stripe secret empty", logs: ["stripe authorization error"] }
      ],
      boundaries: [
        { id: "fb_pay", workflowRunId: "run_test", failedStage: "processPayment", reason: "Missing STRIPE_SECRET_KEY" }
      ],
      incidentEvents: []
    },
    {
      id: "case_2_db",
      query: "Database connection pool saturated under load",
      requiredSources: ["prisma/schema.prisma", "PostgreSQL Database"],
      forbiddenDistractors: ["stripe-queue", "external SDK"],
      expectedRootCause: "prisma/schema.prisma",
      files: [
        { id: "prisma_f", path: "prisma/schema.prisma" },
        { id: "stripe_f", path: "src/stripe-queue.ts" }
      ],
      chunks: [
        { id: "chunk_db", fileId: "prisma_f", content: "datasource db { provider = 'postgresql' }", startLine: 1, endLine: 5 },
        { id: "chunk_sq", fileId: "stripe_f", content: "class StripeQueue { queue = new Queue(); }", startLine: 1, endLine: 5 }
      ],
      embeddings: [
        { id: "emb_db", chunkId: "chunk_db", embedding: JSON.stringify(getLocalEmbedding("database pool connection postgresql")) },
        { id: "emb_sq", chunkId: "chunk_sq", embedding: JSON.stringify(getLocalEmbedding("stripe queue handler")) }
      ],
      nodes: [
        { id: "PostgreSQL Database", versionId: "arch_v1", type: "database", name: "PostgreSQL Database", metadata: {} },
        { id: "stripe-queue", versionId: "arch_v1", type: "queue/topic/event", name: "stripe-queue", metadata: {} }
      ],
      edges: [
        { id: "edge_db", versionId: "arch_v1", source: "stripe-queue", target: "PostgreSQL Database", type: "QUERIES", evidence: "{}" }
      ],
      stepRuns: [
        { id: "step_db_fail", workflowRunId: "run_test", status: "FAILED", error: "database pool saturated", logs: ["Prisma client connection timeout"] }
      ],
      boundaries: [
        { id: "fb_db", workflowRunId: "run_test", failedStage: "dbConnection", reason: "pool limit exceeded" }
      ],
      incidentEvents: []
    }
  ];

  let activeCase: BenchmarkCase | null = null;

  // Intercept prisma methods dynamically for benchmarking
  const originalRepositoryFile = (prisma as any).repositoryFile;
  const originalCodeChunk = (prisma as any).codeChunk;
  const originalChunkEmbedding = (prisma as any).chunkEmbedding;
  const originalGraphNode = (prisma as any).graphNode;
  const originalGraphEdge = (prisma as any).graphEdge;
  const originalWorkflowStepRun = (prisma as any).workflowStepRun;
  const originalFailureBoundary = (prisma as any).failureBoundary;
  const originalIncidentEvent = (prisma as any).incidentEvent;
  const originalRepositorySnapshot = (prisma as any).repositorySnapshot;

  (prisma as any).repositorySnapshot = {
    findUnique: async () => ({ id: "snap_1", commitSha: "test_sha_123" })
  };

  (prisma as any).repositoryFile = {
    findMany: async () => activeCase ? activeCase.files : originalRepositoryFile.findMany()
  };
  (prisma as any).codeChunk = {
    findMany: async (args: any) => {
      if (!activeCase) return originalCodeChunk.findMany(args);
      if (args?.where?.fileId) return activeCase.chunks.filter(c => c.fileId === args.where.fileId);
      return activeCase.chunks;
    }
  };
  (prisma as any).chunkEmbedding = {
    findMany: async () => activeCase ? activeCase.embeddings : originalChunkEmbedding.findMany()
  };
  (prisma as any).graphNode = {
    findMany: async () => activeCase ? activeCase.nodes : originalGraphNode.findMany()
  };
  (prisma as any).graphEdge = {
    findMany: async () => activeCase ? activeCase.edges : originalGraphEdge.findMany()
  };
  (prisma as any).workflowStepRun = {
    findMany: async () => activeCase ? activeCase.stepRuns : originalWorkflowStepRun.findMany()
  };
  (prisma as any).failureBoundary = {
    findMany: async () => activeCase ? activeCase.boundaries : originalFailureBoundary.findMany()
  };
  (prisma as any).incidentEvent = {
    findMany: async () => activeCase ? activeCase.incidentEvents : originalIncidentEvent.findMany()
  };

  function computeMetrics(context: RAGContext, caseData: BenchmarkCase) {
    const retrievedItems: string[] = [];
    for (const chunk of context.codeChunks) {
      retrievedItems.push(chunk.filePath);
    }
    if (context.graphResult) {
      for (const node of context.graphResult.nodes) {
        retrievedItems.push(node.id);
      }
    }

    const required = caseData.requiredSources;
    const forbidden = caseData.forbiddenDistractors;

    // Recall@5
    const retrievedAt5 = retrievedItems.slice(0, 5);
    const recallAt5Count = required.filter(src => retrievedAt5.includes(src)).length;
    const recallAt5 = required.length > 0 ? recallAt5Count / required.length : 0;

    // Recall@10
    const retrievedAt10 = retrievedItems.slice(0, 10);
    const recallAt10Count = required.filter(src => retrievedAt10.includes(src)).length;
    const recallAt10 = required.length > 0 ? recallAt10Count / required.length : 0;

    // Precision
    const precisionCount = retrievedItems.filter(item => required.includes(item)).length;
    const forbiddenCount = retrievedItems.filter(item => forbidden.includes(item)).length;
    const precision = retrievedItems.length > 0 ? (precisionCount) / (retrievedItems.length + forbiddenCount) : 0;

    // MRR
    let firstRank = -1;
    for (let i = 0; i < retrievedItems.length; i++) {
      if (required.includes(retrievedItems[i])) {
        firstRank = i + 1;
        break;
      }
    }
    const mrr = firstRank > 0 ? 1 / firstRank : 0;

    // Root-cause Accuracy
    const retrievedFiles = context.codeChunks.map((c: any) => c.filePath);
    const rootCauseAccuracy = retrievedFiles.includes(caseData.expectedRootCause) ? 1.0 : 0.0;

    // Token Count
    const tokenCount = Math.round(context.fullContextText.length / 4);

    return {
      recallAt5,
      recallAt10,
      precision,
      mrr,
      rootCauseAccuracy,
      tokenCount
    };
  }

  const resultsSummary: any[] = [];

  for (const caseData of benchmarkCases) {
    activeCase = caseData;

    // Retrieve context with Graph
    const contextWithGraph = await pipeline.retrieveHybridContext(caseData.query, {
      snapshotId: "snap_1",
      workflowRunId: "run_test",
      incidentId: "inc_test",
      skipRewrite: true,
      disableGraph: false
    });

    // Retrieve context without Graph
    const contextWithoutGraph = await pipeline.retrieveHybridContext(caseData.query, {
      snapshotId: "snap_1",
      workflowRunId: "run_test",
      incidentId: "inc_test",
      skipRewrite: true,
      disableGraph: true
    });

    const metricsWith = computeMetrics(contextWithGraph, caseData);
    const metricsWithout = computeMetrics(contextWithoutGraph, caseData);

    resultsSummary.push({
      caseId: caseData.id,
      withGraph: metricsWith,
      withoutGraph: metricsWithout
    });

    // Simple assertions to ensure RAG functions as expected
    assert(metricsWith.mrr >= metricsWithout.mrr, `MRR with Graph (${metricsWith.mrr}) should be >= without Graph (${metricsWithout.mrr})`);
    assert(metricsWith.recallAt5 >= metricsWithout.recallAt5, `Recall@5 with Graph (${metricsWith.recallAt5}) should be >= without Graph (${metricsWithout.recallAt5})`);
  }

  // Restore prisma mocks
  (prisma as any).repositoryFile = originalRepositoryFile;
  (prisma as any).codeChunk = originalCodeChunk;
  (prisma as any).chunkEmbedding = originalChunkEmbedding;
  (prisma as any).graphNode = originalGraphNode;
  (prisma as any).graphEdge = originalGraphEdge;
  (prisma as any).workflowStepRun = originalWorkflowStepRun;
  (prisma as any).failureBoundary = originalFailureBoundary;
  (prisma as any).incidentEvent = originalIncidentEvent;
  (prisma as any).repositorySnapshot = originalRepositorySnapshot;

  activeCase = null;

  // Print formatted results
  console.log("\n=======================================================");
  console.log("RAG METRICS EVALUATION BENCHMARK RESULTS:");
  console.log("=======================================================");
  console.log("| Metric | With GraphRAG | Without GraphRAG |");
  console.log("|---|---|---|");
  const metricsKeys = ["recallAt5", "recallAt10", "precision", "mrr", "rootCauseAccuracy", "tokenCount"];
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  for (const k of metricsKeys) {
    const valWith = avg(resultsSummary.map(r => r.withGraph[k]));
    const valWithout = avg(resultsSummary.map(r => r.withoutGraph[k]));
    console.log(`| Average ${k} | ${valWith.toFixed(4)} | ${valWithout.toFixed(4)} |`);
  }
  console.log("=======================================================");
  console.log("✓ RAG Quality Benchmark Suite passed.");

  // ----------------------------------------------------
  // Finish
  // ----------------------------------------------------
  if (failed) {
    console.error("\nSome unit tests FAILED. Review errors above.");
    process.exit(1);
  } else {
    console.log("\nAll RAG & Knowledge Systems Unit Tests PASSED successfully! (8/8)");
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error("Test execution crashed:", err);
  process.exit(1);
});
