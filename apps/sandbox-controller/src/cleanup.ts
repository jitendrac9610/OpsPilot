import fs from "node:fs";
import { execSync } from "node:child_process";
import { ChildProcess } from "node:child_process";
import { logger } from "@opspilot/shared";

export class CleanupManager {
  public async terminateProcesses(processes: ChildProcess[]) {
    logger.info({ count: processes.length }, "Terminating sandbox processes");
    for (const proc of processes) {
      if (proc.pid) {
        try {
          if (process.platform === "win32") {
            execSync(`taskkill /f /t /pid ${proc.pid}`, { stdio: "ignore" });
          } else {
            process.kill(-proc.pid, "SIGKILL");
          }
        } catch (err: any) {
          try {
            proc.kill("SIGKILL");
          } catch (e) {}
        }
      }
    }
  }

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
