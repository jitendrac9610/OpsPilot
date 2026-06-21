import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";
import { CorrelationManager, TraceEvent } from "./correlation.js";

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
  hypotheses: Array<{
    description: string;
    confidence: number;
    status: "SUPPORTED" | "CONTRADICTED" | "NEUTRAL";
    evidence: string[];
  }>;
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
    reason: string
  ): Promise<string> {
    logger.warn({ workflowRunId, failedStage, reason }, "Localizing failed workflow stage");

    const timeline = await this.correlationManager.getCorrelationTimeline(workflowRunId);
    const report = this.analyzeTimeline(timeline, failedStage, reason);

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

  private analyzeTimeline(timeline: TraceEvent[], failedStage: string, reason: string): LocalizationReport {
    let affectedService = "api";
    let errorLog: string | undefined;

    // Find the first error or failed event in the timeline
    for (const event of timeline) {
      if (event.error || (event.logs && event.logs.some(l => l.includes("failed") || l.includes("error") || l.includes("500")))) {
        affectedService = event.service;
        errorLog = event.error || (event.logs ? event.logs.join("\n") : undefined);
        break;
      }
    }

    if (!errorLog) {
      errorLog = reason;
    }

    // Attempt to extract stack traces, files, and lines
    const sourceSymbol = this.parseStackTraces(errorLog);
    const failingConfiguration = this.detectMissingConfig(errorLog);

    // Formulate hypotheses based on logs
    const hypotheses = this.generateHypotheses(errorLog, failingConfiguration);
    const finalRootCause = hypotheses.find(h => h.status === "SUPPORTED")?.description || "Unknown runtime failure";

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

  private generateHypotheses(log: string, missingConfig?: string): LocalizationReport["hypotheses"] {
    const list: LocalizationReport["hypotheses"] = [];

    if (missingConfig) {
      list.push({
        description: `Missing required environment variable: ${missingConfig}`,
        confidence: 95,
        status: "SUPPORTED",
        evidence: [`Log explicitly states configuration parameter ${missingConfig} is missing or empty.`]
      });
    } else {
      list.push({
        description: `Missing required environment variable`,
        confidence: 40,
        status: "NEUTRAL",
        evidence: ["No explicit environment variables matching error pattern found."]
      });
    }

    // Prisma / Database schema mismatch hypothesis
    const hasDbError = log.includes("prisma") || log.includes("database") || log.includes("relation") || log.includes("foreign key");
    list.push({
      description: "Database schema mismatch or Prisma model out of sync",
      confidence: hasDbError ? 85 : 10,
      status: hasDbError ? "SUPPORTED" : "NEUTRAL",
      evidence: hasDbError ? ["Prisma client or SQL relation error in stack trace."] : []
    });

    // Network connection/timeout hypothesis
    const hasNetworkError = log.includes("ECONNREFUSED") || log.includes("timeout") || log.includes("fetch failed");
    list.push({
      description: "Service connection refused or network timeout",
      confidence: hasNetworkError ? 90 : 10,
      status: hasNetworkError ? "SUPPORTED" : "NEUTRAL",
      evidence: hasNetworkError ? ["Connection error message matched in logs."] : []
    });

    return list;
  }
}
