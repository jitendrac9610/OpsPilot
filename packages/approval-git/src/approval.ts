import crypto from "node:crypto";
import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export class ApprovalManager {
  private dbFallback = false;

  constructor(dbFallback = false) {
    this.dbFallback = dbFallback;
  }

  public async createApprovalRequest(
    remediationPlanId: string,
    requestedBy = "agent-runtime",
    patchHash?: string
  ): Promise<string> {
    logger.info({ remediationPlanId, requestedBy }, "Creating approval request card");

    let requestId = `appr-${Math.random().toString(36).substring(2, 9)}`;
    const finalPatchHash = patchHash || (this.dbFallback
      ? hashPatchPayload([{ remediationPlanId, fallback: true }])
      : await computePatchHash(remediationPlanId));

    if (!this.dbFallback) {
      try {
        const ar = await prisma.approvalRequest.create({
          data: {
            id: requestId,
            remediationPlanId,
            patchHash: finalPatchHash,
            status: "WAITING_FOR_APPROVAL",
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
    actionType: "PR_MERGE" | "INFRA_RESTART" | "APPLY_CONFIG",
    currentPatchHash?: string,
    approvalComment?: string
  ): Promise<{ success: boolean; approvedActionId?: string }> {
    logger.info({ requestId, approvedBy, actionType }, "Approving request and initiating action execution");

    if (!this.dbFallback) {
      try {
        const approval = await prisma.approvalRequest.findUnique({ where: { id: requestId } });
        if (!approval) {
          throw new Error(`Approval request ${requestId} was not found.`);
        }
        if (approval.expiresAt && approval.expiresAt.getTime() < Date.now()) {
          throw new Error(`Approval request ${requestId} has expired.`);
        }
        const expectedHash = currentPatchHash || await computePatchHash(approval.remediationPlanId);
        if (approval.patchHash && expectedHash !== approval.patchHash) {
          throw new Error("Patch changed after approval request was created.");
        }

        await prisma.approvalRequest.update({
          where: { id: requestId },
          data: {
            status: "APPROVED",
            approvedBy,
            approvalComment,
            decidedAt: new Date()
          }
        });
      } catch (err: any) {
        logger.warn({ err }, "Database approval status update failed.");
        throw err;
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
            status: "APPROVED"
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

export async function computePatchHash(remediationPlanId: string): Promise<string> {
  const changeSets = await prisma.changeSet.findMany({
    where: { remediationPlanId },
    orderBy: { createdAt: "asc" }
  });
  const files = await prisma.changeSetFile.findMany({
    where: { changeSetId: { in: changeSets.map((changeSet) => changeSet.id) } },
    orderBy: [{ path: "asc" }, { id: "asc" }]
  });
  if (files.length === 0) {
    throw new Error(`PATCH_HASH_UNAVAILABLE: remediation plan ${remediationPlanId} has no changeset files.`);
  }
  return hashPatchPayload(files.map((file) => ({
    path: file.path,
    diff: file.diff,
    originalHash: file.originalHash || ""
  })));
}

export function hashPatchPayload(payload: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}
