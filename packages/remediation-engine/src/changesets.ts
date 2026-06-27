import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export class ChangeSetManager {
  private dbFallback = false;

  constructor(dbFallback = false) {
    this.dbFallback = dbFallback;
  }

  public async createChangeSet(
    remediationPlanId: string,
    files: { path: string; diff: string; originalHash?: string }[]
  ): Promise<{ changeSetId: string; branchName: string }> {
    const branchName = `opspilot-fix-${Math.random().toString(36).substring(2, 9)}`;
    logger.info({ remediationPlanId, branchName }, "Creating remediation changeset and branch");

    let changeSetId = `cs-${Math.random().toString(36).substring(2, 9)}`;

    if (!this.dbFallback) {
      try {
        const cs = await prisma.changeSet.create({
          data: {
            id: changeSetId,
            remediationPlanId,
            branchName
          }
        });
        changeSetId = cs.id;
      } catch (err: any) {
        logger.warn({ err }, "Database ChangeSet creation failed.");
        this.dbFallback = true;
      }
    }

    if (!this.dbFallback) {
      try {
        for (const file of files) {
          await prisma.changeSetFile.create({
            data: {
              changeSetId,
              path: file.path,
              diff: file.diff,
              originalHash: file.originalHash
            }
          });
        }
      } catch (err: any) {
        logger.warn({ err }, "Failed to write ChangeSetFile entries to database");
      }
    }

    return { changeSetId, branchName };
  }
}
