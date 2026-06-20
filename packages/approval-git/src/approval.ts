import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export class ApprovalManager {
  private dbFallback = false;

  constructor(dbFallback = false) {
    this.dbFallback = dbFallback;
  }

  public async createApprovalRequest(
    remediationPlanId: string,
    requestedBy = "agent-runtime"
  ): Promise<string> {
    logger.info({ remediationPlanId, requestedBy }, "Creating approval request card");

    let requestId = `appr-${Math.random().toString(36).substring(2, 9)}`;

    if (!this.dbFallback) {
      try {
        const ar = await prisma.approvalRequest.create({
          data: {
            id: requestId,
            remediationPlanId,
            status: "PENDING",
            requestedBy
          }
        });
        requestId = ar.id;
      } catch (err: any) {
        logger.warn({ err }, "Database ApprovalRequest creation failed.");
        this.dbFallback = true;
      }
    }

    return requestId;
  }

  public async approveRequest(
    requestId: string,
    approvedBy: string,
    actionType: "PR_MERGE" | "INFRA_RESTART" | "APPLY_CONFIG"
  ): Promise<{ success: boolean; approvedActionId?: string }> {
    logger.info({ requestId, approvedBy, actionType }, "Approving request and initiating action execution");

    if (!this.dbFallback) {
      try {
        await prisma.approvalRequest.update({
          where: { id: requestId },
          data: {
            status: "APPROVED",
            approvedBy
          }
        });
      } catch (err: any) {
        logger.warn({ err }, "Database approval status update failed.");
      }
    }

    let approvedActionId = `act-${Math.random().toString(36).substring(2, 9)}`;

    if (!this.dbFallback) {
      try {
        const act = await prisma.approvedAction.create({
          data: {
            id: approvedActionId,
            requestId,
            type: actionType,
            status: "EXECUTED"
          }
        });
        approvedActionId = act.id;
      } catch (err: any) {
        logger.warn({ err }, "Database ApprovedAction recording failed.");
      }
    }

    return {
      success: true,
      approvedActionId
    };
  }
}
