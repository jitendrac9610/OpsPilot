import fs from "node:fs";
import { logger } from "@opspilot/shared";

export class CleanupManager {
  public async deleteWorkspaceDir(workspaceDir: string) {
    logger.info({ workspaceDir }, "Deleting temporary workspace directory");
    if (fs.existsSync(workspaceDir)) {
      try {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      } catch (err: any) {
        logger.warn({ err, workspaceDir }, "Failed to delete workspace directory immediately. Retrying in 1 second.");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
        } catch (e) {
          logger.error({ e, workspaceDir }, "Failed to delete workspace directory after retry.");
        }
      }
    }
  }
}
