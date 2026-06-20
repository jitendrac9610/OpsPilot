import { prisma } from "@opspilot/database";
import { generateId } from "@opspilot/shared";
import { CodeStore, CodeChunkResult } from "./store/code.js";
import { GraphStore, GraphRAGResult } from "./store/graph.js";
import { RuntimeStore, RuntimeRAGResult } from "./store/runtime.js";
import { DocsStore, DocsRAGResult } from "./store/docs.js";
import { IncidentStore, IncidentRAGResult } from "./store/incident.js";
import { ProjectStore, ProjectRAGResult } from "./store/project.js";
import { rewriteQuery } from "./utils/llm.js";

export interface RAGContext {
  objective: string;
  originalQuery: string;
  codeChunks: CodeChunkResult[];
  graphResult: GraphRAGResult | null;
  runtimeResult: RuntimeRAGResult;
  docsResult: DocsRAGResult;
  incidentResult: IncidentRAGResult;
  projectResult: ProjectRAGResult;
  qualityAssessment: {
    assessment: "SUFFICIENT" | "WEAK" | "CONFLICTING";
    reasons: string[];
  };
  fullContextText: string;
}

export class RAGPipeline {
  private codeStore = new CodeStore();
  private graphStore = new GraphStore();
  private runtimeStore = new RuntimeStore();
  private docsStore = new DocsStore();
  private incidentStore = new IncidentStore();
  private projectStore = new ProjectStore();

  /**
   * Orchestrates the complete hybrid RAG pipeline: coordinates parallel store retrieval,
   * evaluates context quality, persists retrieval metadata for observability,
   * and compiles the final structured context text block.
   */
  async retrieveHybridContext(
    query: string,
    options: {
      snapshotId: string;
      agentRunId?: string;
      workflowRunId?: string;
      incidentId?: string;
      limit?: number;
      skipRewrite?: boolean;
    }
  ): Promise<RAGContext> {
    const limit = options.limit ?? 5;
    const agentRunId = options.agentRunId ?? "unknown_run";

    // 1. Optional query rewrite/decomposition using LLM
    const rewrittenQuery = options.skipRewrite
      ? query
      : await rewriteQuery(query);

    // 2. Parallel retrieval from all stores
    const [
      codeChunks,
      graphResult,
      runtimeResult,
      docsResult,
      incidentResult,
      projectResult,
    ] = await Promise.all([
      this.codeStore.searchCode(rewrittenQuery, { snapshotId: options.snapshotId, limit }),
      this.graphStore.searchGraph(rewrittenQuery, { snapshotId: options.snapshotId }),
      this.runtimeStore.searchRuntime(rewrittenQuery, {
        workflowRunId: options.workflowRunId,
        incidentId: options.incidentId,
        limit,
      }),
      this.docsStore.searchDocs(rewrittenQuery, { limit: 3 }),
      this.incidentStore.searchIncidents(rewrittenQuery, { limit: 3 }),
      this.projectStore.searchProjectKnowledge(rewrittenQuery, { limit: 3 }),
    ]);

    // 3. Quality Assessment Gate
    const reasons: string[] = [];
    let assessment: "SUFFICIENT" | "WEAK" | "CONFLICTING" = "SUFFICIENT";

    if (codeChunks.length === 0) {
      assessment = "WEAK";
      reasons.push("No relevant code chunks retrieved.");
    }
    if (!graphResult || graphResult.nodes.length === 0) {
      if (assessment === "SUFFICIENT") assessment = "WEAK";
      reasons.push("No architecture graph nodes matched the query.");
    }
    if (runtimeResult.stepRuns.length === 0 && runtimeResult.incidentEvents.length === 0) {
      reasons.push("No active runtime step logs or incident event telemetry found.");
    }

    if (reasons.length === 0) {
      reasons.push("Sufficient code, architecture graph, and telemetry matched the incident signature.");
    }

    const qualityAssessment = { assessment, reasons };

    // 4. Persist retrieval observability records to database
    try {
      const retrievalRound = await prisma.retrievalRound.create({
        data: {
          agentRunId,
          query: rewrittenQuery,
        },
      });

      // Save Code chunks candidates
      for (const chunk of codeChunks) {
        await prisma.retrievalCandidate.create({
          data: {
            retrievalRoundId: retrievalRound.id,
            sourceId: chunk.id,
            sourceType: "CODE_CHUNK",
            score: chunk.score,
          },
        });
      }

      // Save Graph nodes candidates
      if (graphResult) {
        for (const node of graphResult.nodes) {
          await prisma.retrievalCandidate.create({
            data: {
              retrievalRoundId: retrievalRound.id,
              sourceId: node.id,
              sourceType: "GRAPH_NODE",
              score: 1.0,
            },
          });
        }
      }

      await prisma.retrievalQualityAssessment.create({
        data: {
          retrievalRoundId: retrievalRound.id,
          assessment: qualityAssessment.assessment,
          reasons: JSON.stringify(qualityAssessment.reasons),
        },
      });
    } catch (dbErr) {
      // Log DB persistence warning but do not crash RAG context retrieval
      console.warn("Failed to write RAG observability records to database:", dbErr);
    }

    // 5. Compile full text context package
    const fullContextText = this.compileFullContextText({
      objective: rewrittenQuery,
      originalQuery: query,
      codeChunks,
      graphResult,
      runtimeResult,
      docsResult,
      incidentResult,
      projectResult,
      qualityAssessment,
    });

    return {
      objective: rewrittenQuery,
      originalQuery: query,
      codeChunks,
      graphResult,
      runtimeResult,
      docsResult,
      incidentResult,
      projectResult,
      qualityAssessment,
      fullContextText,
    };
  }

  private compileFullContextText(ctx: Omit<RAGContext, "fullContextText">): string {
    const textParts: string[] = [];

    textParts.push(`# OpsPilot Hybrid RAG Context Package`);
    textParts.push(`**Target Objective**: "${ctx.objective}"`);
    textParts.push(`**Original Query**: "${ctx.originalQuery}"\n`);

    textParts.push(`## Context Quality Assessment`);
    textParts.push(`Status: **${ctx.qualityAssessment.assessment}**`);
    textParts.push("Reasons:");
    for (const r of ctx.qualityAssessment.reasons) {
      textParts.push(`- ${r}`);
    }
    textParts.push("");

    // Telemetry & Logs
    textParts.push(ctx.runtimeResult.telemetrySummary);
    textParts.push("");

    // GraphRAG
    if (ctx.graphResult) {
      textParts.push(ctx.graphResult.pathsSummary);
      textParts.push("");
    }

    // Code chunks
    textParts.push("## Relevant Code & Configuration Chunks");
    if (ctx.codeChunks.length > 0) {
      for (const chunk of ctx.codeChunks) {
        textParts.push(`### File: [${chunk.filePath}](file:///${chunk.filePath.replace(/\\/g, "/")}) (Lines: ${chunk.startLine}-${chunk.endLine}, RRF Score: ${chunk.score.toFixed(4)})`);
        textParts.push("```typescript");
        textParts.push(chunk.content);
        textParts.push("```\n");
      }
    } else {
      textParts.push("No relevant code or configuration chunks matched.\n");
    }

    // Docs
    textParts.push(ctx.docsResult.docsSummary);
    textParts.push("");

    // Historical Incident Postmortems
    textParts.push(ctx.incidentResult.incidentSummary);
    textParts.push("");

    // Project runbooks
    textParts.push(ctx.projectResult.projectSummary);
    textParts.push("");

    return textParts.join("\n");
  }
}
