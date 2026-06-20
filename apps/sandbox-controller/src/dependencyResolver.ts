import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export class DependencyResolver {
  private dbFallback = false;

  constructor(dbFallback = false) {
    this.dbFallback = dbFallback;
  }

  public async resolve(workspaceDir: string, sandboxId: string): Promise<{ success: boolean; log: string }> {
    logger.info({ workspaceDir, sandboxId }, "Resolving and installing locked dependencies");

    let cmd = "npm install";
    if (fs.existsSync(path.join(workspaceDir, "pnpm-lock.yaml"))) {
      cmd = "pnpm install";
    } else if (fs.existsSync(path.join(workspaceDir, "yarn.lock"))) {
      cmd = "yarn install";
    }

    logger.info({ cmd, workspaceDir }, "Running dependency installer command");

    // For test simulation, if node_modules doesn't exist, we can create a mock package-lock or just run command
    // Since we write mock scripts, we can run command which will complete instantly (since there are no dependencies).
    const result = await new Promise<{ success: boolean; log: string }>((resolve) => {
      exec(cmd, { cwd: workspaceDir }, (error, stdout, stderr) => {
        const log = stdout + "\n" + stderr;
        if (error) {
          logger.error({ error, cmd }, "Dependency installation failed");
          resolve({ success: false, log });
        } else {
          logger.info({ cmd }, "Dependency installation completed successfully");
          resolve({ success: true, log });
        }
      });
    });

    if (!this.dbFallback) {
      try {
        await prisma.buildRun.create({
          data: {
            sandboxId,
            success: result.success,
            log: result.log
          }
        });
      } catch (err: any) {
        logger.warn({ err }, "Failed to write BuildRun log to database");
      }
    }

    return result;
  }
}
