import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export interface TraceEvent {
  timestamp: string;
  service: string;
  component: "http" | "database" | "queue" | "websocket" | "webhook" | "logs";
  action: string;
  input?: any;
  output?: any;
  logs?: string[];
  error?: string;
}

export class CorrelationManager {
  constructor(private readonly dbFallback = false) {}

  public async startWorkflowRun(workflowId: string): Promise<string> {
    const runId = `wfrun-${Math.random().toString(36).substring(2, 9)}`;
    const correlationId = `trace-${Math.random().toString(36).substring(2, 9)}`;

    logger.info({ runId, workflowId, correlationId }, "Starting synthetic workflow run");

    if (!this.dbFallback) {
      try {
        await prisma.workflowRun.create({
          data: {
            id: runId,
            workflowId,
            status: "RUNNING",
            correlationId
          }
        });
        
        await prisma.workflowCorrelation.create({
          data: {
            workflowRunId: runId,
            traceId: correlationId
          }
        });
      } catch (err: any) {
        logger.warn({ err }, "Database workflowRun registration failed.");
      }
    }

    return runId;
  }

  public async recordStepRun(
    workflowRunId: string,
    stepId: string,
    status: "COMPLETED" | "FAILED",
    logs: string[],
    error?: string
  ) {
    logger.info({ workflowRunId, stepId, status }, "Recording step execution run");

    if (!this.dbFallback) {
      try {
        await prisma.workflowStepRun.create({
          data: {
            workflowRunId,
            stepId,
            status,
            logs,
            error
          }
        });
      } catch (err: any) {
        logger.warn({ err }, "Database step run registration failed.");
      }
    }
  }

  /**
   * Appends trace telemetry events linked to a correlation ID.
   */
  public async recordTraceEvent(workflowRunId: string, event: TraceEvent) {
    logger.info({ workflowRunId, event }, "Recording trace correlation event");
    if (this.dbFallback) return;

    try {
      // Append structured event logs into the step runs for correlation
      const stepRun = await prisma.workflowStepRun.findFirst({
        where: { workflowRunId },
        orderBy: { id: "desc" }
      });

      if (stepRun) {
        const updatedLogs = [...stepRun.logs, JSON.stringify(event)];
        await prisma.workflowStepRun.update({
          where: { id: stepRun.id },
          data: {
            logs: updatedLogs,
            error: event.error || stepRun.error
          }
        });
      }
    } catch (err: any) {
      logger.warn({ err }, "Failed to append trace event");
    }
  }

  /**
   * Resolves a complete chronological trace timeline across all services for a workflow run.
   */
  public async getCorrelationTimeline(workflowRunId: string): Promise<TraceEvent[]> {
    if (this.dbFallback) return [];
    try {
      const stepRuns = await prisma.workflowStepRun.findMany({
        where: { workflowRunId }
      });

      const events: TraceEvent[] = [];
      for (const step of stepRuns) {
        for (const log of step.logs) {
          try {
            const parsed = JSON.parse(log);
            if (parsed.timestamp && parsed.service && parsed.component) {
              events.push(parsed);
            }
          } catch {
            // Treat as raw text log event
            events.push({
              timestamp: new Date().toISOString(),
              service: "workflow-engine",
              component: "logs",
              action: "text-log",
              logs: [log]
            });
          }
        }
      }

      return events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    } catch {
      return [];
    }
  }

  public async completeWorkflowRun(runId: string, status: "COMPLETED" | "FAILED") {
    logger.info({ runId, status }, "Completing workflow execution run");

    if (!this.dbFallback) {
      try {
        await prisma.workflowRun.update({
          where: { id: runId },
          data: {
            status,
            completedAt: new Date()
          }
        });
      } catch (err: any) {
        logger.warn({ err }, "Database workflowRun update failed.");
      }
    }
  }
}
