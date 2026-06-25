import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";
import { EvidenceEvent } from "@opspilot/schemas";
import { CorrelationManager } from "./correlation.js";

export interface HypothesisInfo {
  statement: string;
  sourceSymbols: Array<{
    file: string;
    lineRange?: string;
  }>;
  supportingEvidence: string[];
  contradictingEvidence: string[];
  confirmationExperiment: string;
  confidence: number;
  status: "SUPPORTED" | "CONTRADICTED" | "NEUTRAL";
}

export interface LocalizationReport {
  boundaryId: string;
  failedStage: string;
  reason: string;
  affectedService?: string;
  sourceSymbol?: {
    file: string;
    functionOrClass?: string;
    lineRange?: string;
  };
  failingConfiguration?: string;
  hypotheses: HypothesisInfo[];
  finalRootCause?: string;
}

export class FailureLocalizer {
  private correlationManager: CorrelationManager;

  constructor(private readonly dbFallback = false) {
    this.correlationManager = new CorrelationManager(dbFallback);
  }

  public async localizeFailure(
    workflowRunId: string,
    failedStage: string,
    reason: string,
    snapshotId?: string
  ): Promise<string> {
    logger.warn({ workflowRunId, failedStage, reason, snapshotId }, "Localizing failed workflow stage");

    const timeline = await this.correlationManager.getEvidenceTimeline(workflowRunId);
    const report = await this.analyzeTimeline(timeline, failedStage, reason, snapshotId, workflowRunId);

    let boundaryId = `fb-${Math.random().toString(36).substring(2, 9)}`;

    if (!this.dbFallback) {
      try {
        const fb = await prisma.failureBoundary.create({
          data: {
            workflowRunId,
            failedStage,
            reason: JSON.stringify(report)
          }
        });
        boundaryId = fb.id;
      } catch (err: any) {
        logger.warn({ err }, "Database FailureBoundary registration failed.");
      }
    }

    return boundaryId;
  }

  private async analyzeTimeline(
    timeline: EvidenceEvent[],
    failedStage: string,
    reason: string,
    snapshotId?: string,
    workflowRunId?: string
  ): Promise<LocalizationReport> {
    let affectedService = "api";
    let errorLog: string | undefined;

    // Find the first error or failed event in the timeline
    for (const event of timeline) {
      const hasError = !event.success || event.response?.error || (event.response?.logs && event.response.logs.some((l: string) => l.includes("failed") || l.includes("error") || l.includes("500")));
      if (hasError) {
        affectedService = event.service;
        const errStr = event.response?.error || "";
        const logsStr = event.response?.logs ? event.response.logs.join("\n") : "";
        errorLog = `${errStr}\n${logsStr}`.trim();
        break;
      }
    }

    if (!errorLog) {
      errorLog = reason;
    }

    // Attempt to extract stack traces, files, and lines
    const sourceSymbol = this.parseStackTraces(errorLog);
    const failingConfiguration = this.detectMissingConfig(errorLog);

    // Query architecture graph nodes & edges
    let nodes: any[] = [];
    let edges: any[] = [];
    if (snapshotId && !this.dbFallback) {
      try {
        const archVersion = await prisma.architectureVersion.findFirst({
          where: { snapshotId },
          orderBy: { createdAt: "desc" }
        });
        if (archVersion) {
          nodes = await prisma.graphNode.findMany({ where: { versionId: archVersion.id } });
          edges = await prisma.graphEdge.findMany({ where: { versionId: archVersion.id } });
        }
      } catch (err) {
        logger.error({ err }, "Failed to fetch architecture graph for failure localization");
      }
    }

    // Formulate hypotheses based on logs and graph
    const hypotheses = await this.generateHypotheses(errorLog, failingConfiguration, nodes, edges, workflowRunId);
    const finalRootCause = hypotheses.find(h => h.status === "SUPPORTED")?.statement || "Unknown runtime failure";

    return {
      boundaryId: `fb-${Math.random().toString(36).substring(2, 9)}`,
      failedStage,
      reason,
      affectedService,
      sourceSymbol,
      failingConfiguration,
      hypotheses,
      finalRootCause
    };
  }

  private parseStackTraces(log: string): LocalizationReport["sourceSymbol"] {
    // Regex matching common JS/TS stack trace patterns like: at Object.func (file.ts:12:34)
    const match = log.match(/at\s+([A-Za-z0-9_$.]+)\s+\(([^)]+):(\d+):(\d+)\)/) ||
                  log.match(/at\s+([^:]+):(\d+):(\d+)/);

    if (match) {
      const funcOrFile = match[1];
      const filePath = match[2] || funcOrFile;
      const lineNum = Number(match[3] || match[2]);
      const relativePath = filePath.replace(/\\/g, "/").split("/OpsPilot/").pop() || filePath;

      return {
        file: relativePath,
        functionOrClass: match[2] ? funcOrFile : undefined,
        lineRange: `${Math.max(1, lineNum - 5)}-${lineNum + 5}`
      };
    }

    return {
      file: "unknown-source-file.ts"
    };
  }

  private detectMissingConfig(log: string): string | undefined {
    const envMatch = log.match(/process\.env\.([A-Z0-9_]+)/) ||
                     log.match(/environment variable\s+([A-Z0-9_]+)\s+missing/) ||
                     log.match(/JWT secret missing/i);

    if (envMatch) {
      return envMatch[1] || "JWT_SECRET";
    }
    return undefined;
  }

  private async generateHypotheses(
    log: string,
    missingConfig: string | undefined,
    nodes: any[],
    edges: any[],
    workflowRunId?: string
  ): Promise<HypothesisInfo[]> {
    const list: HypothesisInfo[] = [];

    if (missingConfig) {
      list.push({
        statement: `Missing required environment variable: ${missingConfig}`,
        sourceSymbols: [{ file: "src/config.ts" }],
        supportingEvidence: [`Log explicitly states configuration parameter ${missingConfig} is missing or empty.`],
        contradictingEvidence: [],
        confirmationExperiment: `Define environment variable ${missingConfig} in .env or task execution container and verify connection succeeds.`,
        confidence: 95,
        status: "SUPPORTED"
      });
    } else {
      list.push({
        statement: `Missing required environment variable`,
        sourceSymbols: [],
        supportingEvidence: [],
        contradictingEvidence: ["No explicit environment variables matching error pattern found."],
        confirmationExperiment: "Verify that all required environment variables are set in the runtime.",
        confidence: 40,
        status: "NEUTRAL"
      });
    }

    // Prisma / Database schema mismatch hypothesis
    const hasDbError = log.includes("prisma") || log.includes("database") || log.includes("relation") || log.includes("foreign key");
    list.push({
      statement: "Database schema mismatch or Prisma model out of sync",
      sourceSymbols: [{ file: "prisma/schema.prisma" }],
      supportingEvidence: hasDbError ? ["Prisma client or SQL relation error in stack trace."] : [],
      contradictingEvidence: hasDbError ? [] : ["No Prisma or SQL database exceptions detected in application logs."],
      confirmationExperiment: "Run prisma db push or migration deploy on the database sandbox to sync Schema.",
      confidence: hasDbError ? 85 : 10,
      status: hasDbError ? "SUPPORTED" : "NEUTRAL"
    });

    // Network connection/timeout hypothesis
    const hasNetworkError = log.includes("ECONNREFUSED") || log.includes("timeout") || log.includes("fetch failed");
    list.push({
      statement: "Service connection refused or network timeout",
      sourceSymbols: [],
      supportingEvidence: hasNetworkError ? ["Connection error message matched in logs."] : [],
      contradictingEvidence: hasNetworkError ? [] : ["No service network timeouts or refused connections found in trace logs."],
      confirmationExperiment: "Perform an HTTP health check on target port and verify container networking is active.",
      confidence: hasNetworkError ? 90 : 10,
      status: hasNetworkError ? "SUPPORTED" : "NEUTRAL"
    });

    // Queue Name Mismatch hypothesis
    const queueNodes = nodes.filter(n => n.type === "queue/topic/event" && n.id.includes("queue_") && !n.id.includes("inngest_"));
    const onlyProducers = queueNodes.filter(qn => {
      const hasPublisher = edges.some(e => e.target.endsWith(qn.id) && e.type === "PUBLISHES_TO" && !e.id.startsWith("route-to-event-"));
      const hasConsumer = edges.some(e => e.source.endsWith(qn.id) && e.type === "CONSUMES_FROM");
      return hasPublisher && !hasConsumer;
    });
    const onlyConsumers = queueNodes.filter(qn => {
      const hasPublisher = edges.some(e => e.target.endsWith(qn.id) && e.type === "PUBLISHES_TO" && !e.id.startsWith("route-to-event-"));
      const hasConsumer = edges.some(e => e.source.endsWith(qn.id) && e.type === "CONSUMES_FROM");
      return !hasPublisher && hasConsumer;
    });

    for (const prod of onlyProducers) {
      for (const cons of onlyConsumers) {
        if (shareSignificantWord(prod.name, cons.name)) {
          list.push({
            statement: `BullMQ queue-name mismatch: producer publishes to '${prod.name}' but worker consumes from '${cons.name}'`,
            sourceSymbols: [{ file: "src/queue.ts" }],
            supportingEvidence: [
              `Queue '${prod.name}' has publishers but no consumers.`,
              `Queue '${cons.name}' has consumers but no publishers.`
            ],
            contradictingEvidence: [],
            confirmationExperiment: "Update queue consumer initialization to match the producer queue name.",
            confidence: 95,
            status: "SUPPORTED"
          });
        }
      }
    }

    // Inngest Event Name Mismatch hypothesis
    const inngestNodes = nodes.filter(n => n.type === "queue/topic/event" && n.id.includes("inngest_"));
    const onlyInngestProducers = inngestNodes.filter(inN => {
      const hasPublisher = edges.some(e => e.target.endsWith(inN.id) && e.type === "PUBLISHES_TO" && !e.id.startsWith("route-to-event-"));
      const hasConsumer = edges.some(e => e.source.endsWith(inN.id) && e.type === "CONSUMES_FROM");
      return hasPublisher && !hasConsumer;
    });
    const onlyInngestConsumers = inngestNodes.filter(inN => {
      const hasPublisher = edges.some(e => e.target.endsWith(inN.id) && e.type === "PUBLISHES_TO" && !e.id.startsWith("route-to-event-"));
      const hasConsumer = edges.some(e => e.source.endsWith(inN.id) && e.type === "CONSUMES_FROM");
      return !hasPublisher && hasConsumer;
    });

    for (const prod of onlyInngestProducers) {
      for (const cons of onlyInngestConsumers) {
        if (shareSignificantWord(prod.name, cons.name)) {
          list.push({
            statement: `Inngest event-name mismatch: event sent is '${prod.name}' but function triggers on '${cons.name}'`,
            sourceSymbols: [{ file: "src/inngest.ts" }],
            supportingEvidence: [
              `Inngest event '${prod.name}' is emitted but not handled.`,
              `Inngest event '${cons.name}' is handled but never emitted.`
            ],
            contradictingEvidence: [],
            confirmationExperiment: "Rename the event emission or the event listener trigger properties to match.",
            confidence: 95,
            status: "SUPPORTED"
          });
        }
      }
    }

    // Webhook Signature verification failure hypothesis
    const hasWebhookError = log.includes("Webhook Error") || log.includes("stripe-signature") || log.includes("signature verification failed") || log.includes("constructEvent");
    if (hasWebhookError) {
      list.push({
        statement: "Stripe webhook signature verification failure due to parsed req.body instead of raw buffer",
        sourceSymbols: [{ file: "src/stripe.ts" }],
        supportingEvidence: [
          "Log contains Stripe signature verification failure: Webhook Error.",
          "Stripe constructEvent requires a raw buffer payload, but req.body was passed after JSON parsing."
        ],
        contradictingEvidence: [],
        confirmationExperiment: "Configure body-parser or use express.raw({ type: 'application/json' }) middleware on webhook route.",
        confidence: 90,
        status: "SUPPORTED"
      });
    }

    // Clerk token verification Bearer prefix hypothesis
    const hasClerkError = log.includes("verifySession") || log.includes("Bearer sess_") || log.includes("Authorization header") || log.includes("Auth Verification Failed");
    if (hasClerkError) {
      list.push({
        statement: "Clerk authentication token verification failed due to missing Bearer prefix stripping",
        sourceSymbols: [{ file: "src/clerk.ts" }],
        supportingEvidence: [
          "Authorization token verification failed on Clerk.",
          "Authorization token has Bearer prefix but verification expected stripped token."
        ],
        contradictingEvidence: [],
        confirmationExperiment: "Update authorization header extraction to split by Bearer and strip prefix before verification.",
        confidence: 90,
        status: "SUPPORTED"
      });
    }

    // Persist to database if not in fallback mode and workflowRunId is provided
    if (workflowRunId && !this.dbFallback) {
      try {
        let agentRun = await prisma.agentRun.findFirst({
          where: { workflowRunId }
        });
        if (!agentRun) {
          agentRun = await prisma.agentRun.create({
            data: {
              workflowRunId,
              status: "COMPLETED"
            }
          });
        }
        await prisma.hypothesis.deleteMany({
          where: { agentRunId: agentRun.id }
        });
        for (const h of list) {
          await prisma.hypothesis.create({
            data: {
              agentRunId: agentRun.id,
              description: h.statement,
              confidence: h.confidence,
              status: h.status
            }
          });
        }
      } catch (dbErr) {
        logger.error({ dbErr }, "Failed to write hypotheses to database");
      }
    }

    return list;
  }
}

function shareSignificantWord(a: string, b: string): boolean {
  const clean = (str: string) => str.toLowerCase().replace(/[^a-z0-9]/g, " ").split(/\s+/).filter(w => w.length >= 4);
  const wordsA = clean(a);
  const wordsB = clean(b);
  for (const wA of wordsA) {
    for (const wB of wordsB) {
      if (wA === wB || wA + "s" === wB || wB + "s" === wA || wA.slice(0, -1) === wB || wB.slice(0, -1) === wA) {
        return true;
      }
    }
  }
  return false;
}
