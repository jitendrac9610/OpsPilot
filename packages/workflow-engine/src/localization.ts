import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export class FailureLocalizer {
  private dbFallback = false;

  constructor(dbFallback = false) {
    this.dbFallback = dbFallback;
  }

  public async localizeFailure(
    workflowRunId: string,
    failedStage: string,
    reason: string
  ): Promise<string> {
    logger.warn({ workflowRunId, failedStage, reason }, "Localizing failed workflow stage");

    let boundaryId = `fb-${Math.random().toString(36).substring(2, 9)}`;

    if (!this.dbFallback) {
      try {
        const fb = await prisma.failureBoundary.create({
          data: {
            workflowRunId,
            failedStage,
            reason
          }
        });
        boundaryId = fb.id;
      } catch (err: any) {
        logger.warn({ err }, "Database FailureBoundary registration failed.");
      }
    }

    return boundaryId;
  }
}
