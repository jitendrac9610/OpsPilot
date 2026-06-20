import http from "node:http";
import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";
import { ContainerRunner } from "./containerRunner.js";
import { ServiceCommand } from "./executionManifest.js";

export class ServiceStartupManager {
  private readonly activeContainers = new Map<string, string[]>();

  constructor(
    private readonly dbFallback = false,
    private readonly runner = new ContainerRunner()
  ) {}

  public getActiveContainers(sandboxId: string): string[] {
    return this.activeContainers.get(sandboxId) || [];
  }

  public clearContainers(sandboxId: string) {
    this.activeContainers.delete(sandboxId);
  }

  public async stopAll(sandboxId: string) {
    const containers = this.getActiveContainers(sandboxId);
    await Promise.all(containers.map((containerId) => this.runner.stop(containerId)));
    this.clearContainers(sandboxId);
  }

  public async startService(
    sandboxId: string,
    workspaceDir: string,
    service: ServiceCommand,
    environment: Record<string, string> = {}
  ): Promise<{ success: boolean; containerId?: string; log: string }> {
    logger.info({ sandboxId, service }, "Starting discovered service in isolated container");
    const result = await this.runner.startDetached({
      sandboxId,
      workspaceDir,
      command: service.command,
      environment,
      allowNetwork: true,
      ports: service.port ? [service.port] : []
    });

    let healthy = result.success;
    if (healthy && service.port) {
      healthy = await this.waitForPort(service.port, 20);
    }
    if (!healthy && result.containerId) {
      await this.runner.stop(result.containerId);
    }

    if (healthy && result.containerId) {
      const current = this.activeContainers.get(sandboxId) || [];
      current.push(result.containerId);
      this.activeContainers.set(sandboxId, current);
    }

    if (!this.dbFallback) {
      try {
        await prisma.sandboxService.create({
          data: {
            sandboxId,
            name: service.name,
            port: service.port || 0,
            status: healthy ? "RUNNING" : "UNHEALTHY"
          }
        });
      } catch (error) {
        logger.warn({ error }, "Failed to persist SandboxService");
      }
    }

    return {
      success: healthy,
      containerId: healthy ? result.containerId : undefined,
      log: healthy ? result.log : `${result.log}\nSERVICE_READINESS_FAILED`
    };
  }

  private async waitForPort(port: number, maxAttempts: number): Promise<boolean> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const active = await new Promise<boolean>((resolve) => {
        const request = http.get({ hostname: "127.0.0.1", port, path: "/", timeout: 1000 }, () => resolve(true));
        request.on("error", () => resolve(false));
        request.on("timeout", () => {
          request.destroy();
          resolve(false);
        });
      });
      if (active) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }
}
