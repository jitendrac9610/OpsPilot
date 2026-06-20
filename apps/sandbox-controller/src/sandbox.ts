import fs from "node:fs";
import path from "node:path";
import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export class SandboxManager {
  private baseDir: string;
  private dbFallback = false;

  constructor() {
    this.baseDir = path.resolve(process.cwd(), "sandbox", "temp");
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  public getWorkspaceDir(sandboxId: string): string {
    return path.join(this.baseDir, sandboxId);
  }

  public async createSandbox(snapshotId: string): Promise<string> {
    const sandboxId = `sb-${Math.random().toString(36).substring(2, 9)}`;
    const workspaceDir = this.getWorkspaceDir(sandboxId);

    logger.info({ sandboxId, workspaceDir, snapshotId }, "Allocating isolated runtime workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });

    try {
      await prisma.sandbox.create({
        data: {
          id: sandboxId,
          snapshotId,
          status: "ALLOCATED"
        }
      });
    } catch (err: any) {
      logger.warn({ err }, "Database sandbox creation failed. Running in DB-fallback mode.");
      this.dbFallback = true;
    }

    const mockPackageJson = {
      name: "sandbox-app",
      version: "1.0.0",
      scripts: {
        start: "node index.js",
        test: "node test.js"
      },
      dependencies: {}
    };

    fs.writeFileSync(
      path.join(workspaceDir, "package.json"),
      JSON.stringify(mockPackageJson, null, 2)
    );

    fs.writeFileSync(
      path.join(workspaceDir, "index.js"),
      `console.log("Service started. Listening on port 8080...");\n// Keep process alive\nsetInterval(() => {}, 1000);`
    );

    fs.writeFileSync(
      path.join(workspaceDir, "test.js"),
      `console.log("Running unit tests...");\nconsole.log("Tests run: 5, Passed: 5, Failed: 0");\nprocess.exit(0);`
    );

    await this.updateStatus(sandboxId, "ALLOCATED");
    return sandboxId;
  }

  public async updateStatus(sandboxId: string, status: string) {
    logger.info({ sandboxId, status }, "Sandbox status updated");
    if (!this.dbFallback) {
      try {
        await prisma.sandbox.update({
          where: { id: sandboxId },
          data: { status }
        });
      } catch (err: any) {
        logger.warn({ err }, "Failed to update sandbox status in database");
      }
    }
  }
}
