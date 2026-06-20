import { spawn, ChildProcess } from "node:child_process";
import http from "node:http";
import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export class ServiceStartupManager {
  private activeProcesses = new Map<string, ChildProcess[]>();
  private dbFallback = false;

  constructor(dbFallback = false) {
    this.dbFallback = dbFallback;
  }

  public getActiveProcesses(sandboxId: string): ChildProcess[] {
    return this.activeProcesses.get(sandboxId) || [];
  }

  public clearProcesses(sandboxId: string) {
    this.activeProcesses.delete(sandboxId);
  }

  public async startService(
    sandboxId: string,
    workspaceDir: string,
    name: string,
    command: string,
    args: string[] = [],
    port?: number
  ): Promise<{ success: boolean; pid?: number }> {
    logger.info({ sandboxId, name, command, args }, "Starting sandbox background service");

    try {
      // For cross-platform compatibility, run node script if it's start or npm start
      // Note: Child processes are launched using spawn.
      const child = spawn(command, args, {
        cwd: workspaceDir,
        shell: true,
        stdio: "pipe"
      });

      if (!this.activeProcesses.has(sandboxId)) {
        this.activeProcesses.set(sandboxId, []);
      }
      this.activeProcesses.get(sandboxId)!.push(child);

      child.stdout?.on("data", (data) => {
        logger.debug({ service: name, output: data.toString().trim() }, "Service stdout");
      });
      child.stderr?.on("data", (data) => {
        logger.warn({ service: name, output: data.toString().trim() }, "Service stderr");
      });

      // Health readiness check: in unit tests, port can be simulated or checked
      let isHealthy = true;
      if (port) {
        isHealthy = await this.waitForPort(port, 5); // 5 attempts
      }

      const status = isHealthy ? "RUNNING" : "UNHEALTHY";

      if (!this.dbFallback) {
        try {
          await prisma.sandboxService.create({
            data: {
              sandboxId,
              name,
              port: port || 0,
              status
            }
          });
        } catch (err: any) {
          logger.warn({ err }, "Failed to write SandboxService entry to database");
        }
      }

      return { success: isHealthy, pid: child.pid };
    } catch (err: any) {
      logger.error({ err, name }, "Failed to start service process");
      return { success: false };
    }
  }

  private async waitForPort(port: number, maxAttempts: number): Promise<boolean> {
    logger.info({ port }, "Waiting for service port to be active");
    for (let i = 0; i < maxAttempts; i++) {
      const active = await new Promise<boolean>((resolve) => {
        const req = http.get(`http://localhost:${port}/`, (res) => {
          resolve(true);
        });
        req.on("error", () => {
          resolve(false);
        });
        req.end();
      });

      if (active) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }
}
