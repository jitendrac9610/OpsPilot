import http from "node:http";
import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";
import { ContainerRunner, PortBinding } from "./containerRunner.js";
import { ServiceCommand } from "./executionManifest.js";

export class ServiceStartupManager {
  private readonly activeContainers = new Map<string, string[]>();

  constructor(
    private readonly dbFallback = false,
    private readonly runner = new ContainerRunner(),
    private readonly readinessCheck?: (port: number) => Promise<boolean>
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
    environment: Record<string, string> = {},
    network?: string,
    readinessPath = "/"
  ): Promise<{ success: boolean; containerId?: string; log: string; endpoints: PortBinding[] }> {
    logger.info({ sandboxId, service }, "Starting discovered service in isolated container");
    if (!service.port) {
      return {
        success: false,
        log: "APPLICATION_PORT_NOT_DISCOVERED: Refusing to report a service healthy without a verifiable port.",
        endpoints: []
      };
    }

    const result = await this.runner.startDetached({
      sandboxId,
      workspaceDir,
      command: service.command,
      environment,
      allowNetwork: !network,
      network,
      networkAliases: [service.id],
      ports: service.port ? [service.port] : []
    });

    let healthy = result.success;
    const endpoint = result.portBindings.find((binding) => binding.containerPort === service.port);
    if (healthy && service.port && endpoint) {
      healthy = this.readinessCheck
        ? await this.readinessCheck(endpoint.hostPort)
        : await this.waitForHttp(endpoint.hostPort, readinessPath, 40);
    }
    let failureLog = result.log;
    if (!healthy && result.containerId) {
      const containerLogs = await this.runner.logs(result.containerId).catch(() => null);
      if (containerLogs?.log) failureLog = `${failureLog}\n${containerLogs.log}`;
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
            port: endpoint?.hostPort || service.port || 0,
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
      log: healthy ? result.log : `${failureLog}\nSERVICE_READINESS_FAILED`,
      endpoints: healthy ? result.portBindings : []
    };
  }

  private async waitForHttp(port: number, requestPath: string, maxAttempts: number): Promise<boolean> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const active = await new Promise<boolean>((resolve) => {
        const request = http.get(
          { hostname: "127.0.0.1", port, path: requestPath, timeout: 1000 },
          (response) => {
            response.resume();
            resolve((response.statusCode || 500) < 500);
          }
        );
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
