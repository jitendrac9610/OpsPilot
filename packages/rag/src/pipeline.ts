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
  snapshotId?: string;
  commitSha?: string;
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
   * evaluates context quality, persists retrieval metadata for observability.
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
      disableGraph?: boolean;
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
      options.disableGraph
        ? Promise.resolve(null)
        : this.graphStore.searchGraph(rewrittenQuery, { snapshotId: options.snapshotId }),
      this.runtimeStore.searchRuntime(rewrittenQuery, {
        workflowRunId: options.workflowRunId,
        incidentId: options.incidentId,
        limit,
      }),
      this.docsStore.searchDocs(rewrittenQuery, { limit: 3 }),
      this.incidentStore.searchIncidents(rewrittenQuery, { limit: 3 }),
      this.projectStore.searchProjectKnowledge(rewrittenQuery, { limit: 3 }),
    ]);

    // Fetch snapshot commit SHA for citation integrity
    let commitSha = "unknown";
    try {
      const snapshot = await prisma.repositorySnapshot.findUnique({
        where: { id: options.snapshotId },
      });
      if (snapshot && snapshot.commitSha) {
        commitSha = snapshot.commitSha;
      }
    } catch (e) {
      // Bypassed database error
    }

    // 3. Quality Assessment Gate
    const reasons: string[] = [];
    let assessment: "SUFFICIENT" | "WEAK" | "CONFLICTING" = "SUFFICIENT";

    if (codeChunks.length === 0) {
      assessment = "WEAK";
      reasons.push("No relevant code chunks retrieved.");
    }
    if (!options.disableGraph && (!graphResult || graphResult.nodes.length === 0)) {
      if (assessment === "SUFFICIENT") assessment = "WEAK";
      reasons.push("No architecture graph nodes matched the query.");
    }
    if (runtimeResult.stepRuns.length === 0 && runtimeResult.incidentEvents.length === 0) {
      reasons.push("No active runtime step logs or incident event telemetry found.");
    }

    // Causal relevance analysis
    const getTerms = (text: string) => text.toLowerCase().replace(/[^a-z0-9_-]+/g, " ").split(/\s+/).filter(t => t.length > 2);
    const runtimeTerms = new Set<string>();
    for (const fb of runtimeResult.failureBoundaries || []) {
      getTerms(fb.failedStage || "").forEach(t => runtimeTerms.add(t));
      getTerms(fb.reason || "").forEach(t => runtimeTerms.add(t));
    }
    for (const sr of runtimeResult.stepRuns || []) {
      if (sr.error) {
        getTerms(sr.error).forEach(t => runtimeTerms.add(t));
      }
      if (sr.logs) {
        for (const log of sr.logs) {
          getTerms(log).forEach(t => runtimeTerms.add(t));
        }
      }
    }

    if (runtimeTerms.size > 0) {
      let codeCausalMatches = 0;
      let graphCausalMatches = 0;

      for (const chunk of codeChunks) {
        const contentLower = chunk.content.toLowerCase();
        const pathLower = chunk.filePath.toLowerCase();
        for (const term of runtimeTerms) {
          if (contentLower.includes(term) || pathLower.includes(term)) {
            codeCausalMatches++;
            break;
          }
        }
      }

      if (graphResult) {
        for (const node of graphResult.nodes) {
          const nameLower = node.name.toLowerCase();
          const typeLower = node.type.toLowerCase();
          for (const term of runtimeTerms) {
            if (nameLower.includes(term) || typeLower.includes(term)) {
              graphCausalMatches++;
              break;
            }
          }
        }
      }

      if (codeChunks.length > 0 && codeCausalMatches === 0) {
        assessment = "WEAK";
        reasons.push("Causal mismatch: Retrieved code chunks do not reference active runtime error terms.");
      }
      if (graphResult && graphResult.nodes.length > 0 && graphCausalMatches === 0) {
        if (assessment === "SUFFICIENT") assessment = "WEAK";
        reasons.push("Causal mismatch: Retrieved architecture nodes do not reference active runtime error terms.");
      }
      if (codeCausalMatches > 0 && graphCausalMatches > 0) {
        reasons.push(`Causally aligned: Retrieved code and graph nodes match runtime error signatures (matches: code=${codeCausalMatches}, graph=${graphCausalMatches}).`);
      }
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
              score: (node as any).score ?? 1.0,
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
      snapshotId: options.snapshotId,
      commitSha,
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
      snapshotId: options.snapshotId,
      commitSha,
    };
  }

  private compileFullContextText(ctx: Omit<RAGContext, "fullContextText"> & { snapshotId?: string; commitSha?: string }): string {
    const textParts: string[] = [];

    textParts.push(`# OpsPilot Hybrid RAG Context Package`);
    textParts.push(`**Target Objective**: "${ctx.objective}"`);
    textParts.push(`**Original Query**: "${ctx.originalQuery}"`);
    textParts.push(`**Snapshot ID**: \`${ctx.snapshotId || "unknown"}\` | **Commit SHA**: \`${ctx.commitSha || "unknown"}\`\n`);

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
        textParts.push(`### Citation: File [${chunk.filePath}](file:///${chunk.filePath.replace(/\\/g, "/")}) (Lines: ${chunk.startLine}-${chunk.endLine}, Snapshot: \`${ctx.snapshotId || "unknown"}\`, Commit: \`${ctx.commitSha || "unknown"}\`, RRF Score: ${chunk.score.toFixed(4)})`);
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
