import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export class PRManager {
  private dbFallback = false;

  constructor(dbFallback = false) {
    this.dbFallback = dbFallback;
  }

  public async createPR(
    approvedActionId: string,
    branchName: string
  ): Promise<{ success: boolean; prId: string; url: string; number: number }> {
    logger.info({ approvedActionId, branchName }, "Creating Git Pull Request");

    const prNumber = Math.floor(100 + Math.random() * 900);
    const url = `https://github.com/opspilot/demo-repo/pull/${prNumber}`;
    let prId = `pr-${Math.random().toString(36).substring(2, 9)}`;

    if (!this.dbFallback) {
      try {
        const pr = await prisma.pullRequest.create({
          data: {
            id: prId,
            approvedAction: approvedActionId,
            number: prNumber,
            url
          }
        });
        prId = pr.id;
      } catch (err: any) {
        logger.warn({ err }, "Database PullRequest registration failed.");
        this.dbFallback = true;
      }
    }

    return {
      success: true,
      prId,
      url,
      number: prNumber
    };
  }
}
