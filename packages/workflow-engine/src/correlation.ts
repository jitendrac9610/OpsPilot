import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export class CorrelationManager {
  private dbFallback = false;

  constructor(dbFallback = false) {
    this.dbFallback = dbFallback;
  }

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
        this.dbFallback = true;
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
