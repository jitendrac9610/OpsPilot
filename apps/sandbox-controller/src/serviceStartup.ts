import http from "node:http";
import net from "node:net";
import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";
import { ContainerRunner, PortBinding } from "./containerRunner.js";
import { HealthCheck, ServiceCommand } from "./executionManifest.js";

export interface ServiceEndpoint extends PortBinding {
  serviceId: string;
  serviceName: string;
  kind: ServiceCommand["kind"];
}

export interface StartedService {
  serviceId: string;
  serviceName: string;
  kind: ServiceCommand["kind"];
  success: boolean;
  containerId?: string;
  attempts: number;
  log: string;
  endpoints: ServiceEndpoint[];
}

export interface ServiceStartupResult {
  success: boolean;
  services: StartedService[];
  endpoints: ServiceEndpoint[];
  environment: Record<string, string>;
  log: string;
}

type ServiceCommandInput =
  Pick<ServiceCommand, "id" | "name" | "command"> &
  Partial<Omit<ServiceCommand, "id" | "name" | "command">>;

export interface ActiveService {
  service: ServiceCommand;
  containerId: string;
  endpoints: ServiceEndpoint[];
}

export class ServiceStartupManager {
  private readonly activeContainers = new Map<string, Map<string, ActiveService>>();

  constructor(
    private readonly dbFallback = false,
    private readonly runner = new ContainerRunner(),
    private readonly readinessCheck?: (port: number) => Promise<boolean>
  ) {}

  public getActiveContainers(sandboxId: string): string[] {
    return [...(this.activeContainers.get(sandboxId)?.values() || [])]
      .map((service) => service.containerId);
  }

  public getActiveServices(sandboxId: string): ActiveService[] {
    return [...(this.activeContainers.get(sandboxId)?.values() || [])];
  }

  public clearContainers(sandboxId: string) {
    this.activeContainers.delete(sandboxId);
  }

  public async stopAll(sandboxId: string) {
    const containers = this.getActiveContainers(sandboxId);
    await Promise.all(containers.map((containerId) => this.runner.stop(containerId).catch(() => undefined)));
    this.clearContainers(sandboxId);
  }

  public async stopService(sandboxId: string, serviceId: string): Promise<void> {
    const services = this.activeContainers.get(sandboxId);
    const active = services?.get(serviceId);
    if (!active) return;
    await this.runner.stop(active.containerId).catch(() => undefined);
    services?.delete(serviceId);
    if (services?.size === 0) this.activeContainers.delete(sandboxId);
  }

  public async collectLogs(sandboxId: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const active of this.getActiveServices(sandboxId)) {
      const logs = await this.runner.logs(active.containerId).catch((error) => ({
        log: error instanceof Error ? error.message : String(error)
      }));
      result[active.service.id] = logs.log;
    }
    return result;
  }

  public async startServices(
    sandboxId: string,
    workspaceDir: string,
    services: ServiceCommand[],
    environment: Record<string, string> = {},
    network?: string,
    healthChecks: HealthCheck[] = []
  ): Promise<ServiceStartupResult> {
    const started: StartedService[] = [];
    const sharedEnvironment = { ...environment };

    for (const service of services) {
      const unavailableDependency = service.dependsOn.find(
        (dependencyId) => !this.activeContainers.get(sandboxId)?.has(dependencyId)
      );
      if (unavailableDependency) {
        const failure: StartedService = {
          serviceId: service.id,
          serviceName: service.name,
          kind: service.kind,
          success: false,
          attempts: 0,
          log: `SERVICE_DEPENDENCY_NOT_RUNNING: ${service.id} requires ${unavailableDependency}.`,
          endpoints: []
        };
        started.push(failure);
        return this.aggregate(false, started, sharedEnvironment);
      }

      const healthCheck = healthChecks.find((candidate) => candidate.serviceId === service.id);
      const result = await this.startServiceWithHealthCheck(
        sandboxId,
        workspaceDir,
        service,
        sharedEnvironment,
        network,
        healthCheck
      );
      started.push(result);
      if (!result.success) return this.aggregate(false, started, sharedEnvironment);

      const endpoint = result.endpoints[0];
      if (endpoint) {
        const prefix = service.id.replace(/[^a-z0-9]/gi, "_").toUpperCase();
        sharedEnvironment[`OPSPILOT_SERVICE_${prefix}_URL`] = endpoint.internalUrl;
        if (service.kind === "api") {
          sharedEnvironment.API_URL ||= endpoint.internalUrl;
          sharedEnvironment.BACKEND_URL ||= endpoint.internalUrl;
          sharedEnvironment.NEXT_PUBLIC_API_URL ||= endpoint.internalUrl;
        }
        if (service.kind === "frontend") {
          sharedEnvironment.FRONTEND_URL ||= endpoint.internalUrl;
        }
      }
    }

    return this.aggregate(true, started, sharedEnvironment);
  }

  public async startService(
    sandboxId: string,
    workspaceDir: string,
    service: ServiceCommandInput,
    environment: Record<string, string> = {},
    network?: string,
    readinessPath = "/"
  ): Promise<{ success: boolean; containerId?: string; log: string; endpoints: ServiceEndpoint[] }> {
    const healthCheck: HealthCheck = service.port
      ? {
          serviceId: service.id,
          type: "http",
          port: service.port,
          path: readinessPath,
          startupTimeoutMs: 20_000
        }
      : {
          serviceId: service.id,
          type: "process",
          startupTimeoutMs: 5_000
        };
    const result = await this.startServiceWithHealthCheck(
      sandboxId,
      workspaceDir,
      normalizeLegacyService(service),
      environment,
      network,
      healthCheck
    );
    return {
      success: result.success,
      containerId: result.containerId,
      log: result.log,
      endpoints: result.endpoints
    };
  }

  private async startServiceWithHealthCheck(
    sandboxId: string,
    workspaceDir: string,
    service: ServiceCommand,
    environment: Record<string, string>,
    network: string | undefined,
    healthCheck: HealthCheck | undefined
  ): Promise<StartedService> {
    logger.info({ sandboxId, service }, "Starting discovered service in isolated container");
    if (!healthCheck) {
      return {
        serviceId: service.id,
        serviceName: service.name,
        kind: service.kind,
        success: false,
        attempts: 0,
        log: `SERVICE_HEALTH_CHECK_NOT_CONFIGURED: ${service.id}`,
        endpoints: []
      };
    }
    if ((healthCheck.type === "http" || healthCheck.type === "tcp") && !service.port) {
      return {
        serviceId: service.id,
        serviceName: service.name,
        kind: service.kind,
        success: false,
        attempts: 0,
        log: `APPLICATION_PORT_NOT_DISCOVERED: ${service.id} requires ${healthCheck.type} readiness.`,
        endpoints: []
      };
    }
    if (service.command.length === 0 && !service.image && !service.build) {
      return {
        serviceId: service.id,
        serviceName: service.name,
        kind: service.kind,
        success: false,
        attempts: 0,
        log: `SERVICE_COMMAND_NOT_CONFIGURED: ${service.id} has no command, image, or build context.`,
        endpoints: []
      };
    }

    let image = service.image;
    const attemptLogs: string[] = [];
    if (service.build) {
      const build = await this.runner.buildImage({
        sandboxId,
        workspaceDir,
        context: service.build.context,
        dockerfile: service.build.dockerfile,
        name: service.id,
        network
      });
      attemptLogs.push(`[build]\n${build.log}`);
      if (!build.success) {
        return {
          serviceId: service.id,
          serviceName: service.name,
          kind: service.kind,
          success: false,
          attempts: 0,
          log: attemptLogs.join("\n"),
          endpoints: []
        };
      }
      image = build.image;
    }

    const maxAttempts = Math.max(1, service.restartAttempts + 1);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const serviceEnvironment = this.serviceEnvironment(service, environment);
      const useWorkspaceMount = !service.build && (service.source !== "compose" || service.command.length > 0);
      const result = await this.runner.startDetached({
        sandboxId,
        name: service.id,
        workspaceDir: useWorkspaceMount ? workspaceDir : undefined,
        workingDirectory: useWorkspaceMount ? service.workingDirectory : undefined,
        command: service.command,
        image,
        environment: serviceEnvironment,
        allowNetwork: !network,
        network,
        networkAliases: [service.id],
        ports: service.port ? [service.port] : []
      });

      let healthy = result.success && Boolean(result.containerId);
      const endpoint = result.portBindings.find((binding) => binding.containerPort === service.port);
      if (healthy && result.containerId) {
        healthy = await this.waitForReadiness(result.containerId, healthCheck, endpoint);
      }

      let currentLog = result.log;
      if (!healthy && result.containerId) {
        const containerLogs = await this.runner.logs(result.containerId).catch(() => null);
        if (containerLogs?.log) currentLog = `${currentLog}\n${containerLogs.log}`;
        await this.runner.stop(result.containerId).catch(() => undefined);
      }
      attemptLogs.push(`[attempt ${attempt}/${maxAttempts}]\n${currentLog}`);

      if (healthy && result.containerId) {
        const endpoints = result.portBindings.map((binding): ServiceEndpoint => ({
          ...binding,
          serviceId: service.id,
          serviceName: service.name,
          kind: service.kind
        }));
        this.track(sandboxId, service, result.containerId, endpoints);
        await this.persistService(sandboxId, service, endpoints[0]?.hostPort || service.port || 0, "RUNNING");
        return {
          serviceId: service.id,
          serviceName: service.name,
          kind: service.kind,
          success: true,
          containerId: result.containerId,
          attempts: attempt,
          log: attemptLogs.join("\n"),
          endpoints
        };
      }
    }

    await this.persistService(sandboxId, service, service.port || 0, "UNHEALTHY");
    return {
      serviceId: service.id,
      serviceName: service.name,
      kind: service.kind,
      success: false,
      attempts: maxAttempts,
      log: `${attemptLogs.join("\n")}\nSERVICE_READINESS_FAILED: ${service.id}`,
      endpoints: []
    };
  }

  private serviceEnvironment(
    service: ServiceCommand,
    environment: Record<string, string>
  ): Record<string, string> {
    const expandedComposeEnvironment = Object.fromEntries(
      Object.entries(service.environment).map(([name, value]) => [
        name,
        value.replace(/\$\{([A-Z][A-Z0-9_]*)(?::?-(.*?))?\}/g, (_match, variable, fallback) =>
          environment[variable] ?? fallback ?? ""
        )
      ])
    );
    const result = {
      ...environment,
      ...expandedComposeEnvironment
    };
    if (service.port) {
      result.PORT = String(service.port);
      result.HOST ||= "0.0.0.0";
      result.HOSTNAME ||= "0.0.0.0";
      result.BASE_URL = `http://${service.id}:${service.port}`;
      result.APP_URL = `http://${service.id}:${service.port}`;
    }
    result.OPSPILOT_SERVICE_ID = service.id;
    result.OPSPILOT_SERVICE_KIND = service.kind;
    return result;
  }

  private async waitForReadiness(
    containerId: string,
    healthCheck: HealthCheck,
    endpoint?: PortBinding
  ): Promise<boolean> {
    if (healthCheck.type === "process") {
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, healthCheck.startupTimeoutMs)));
      return this.runner.isRunning(containerId);
    }
    if (!endpoint) return false;
    if (this.readinessCheck && healthCheck.type === "http") {
      return this.readinessCheck(endpoint.hostPort);
    }

    const deadline = Date.now() + healthCheck.startupTimeoutMs;
    while (Date.now() < deadline) {
      const ready = healthCheck.type === "http"
        ? await this.probeHttp(endpoint.hostPort, healthCheck.path || "/")
        : await this.probeTcp(endpoint.hostPort);
      if (ready) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  private probeHttp(port: number, requestPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const request = http.get(
        { hostname: "127.0.0.1", port, path: requestPath, timeout: 1_000 },
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
  }

  private probeTcp(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      const finish = (ready: boolean) => {
        socket.destroy();
        resolve(ready);
      };
      socket.setTimeout(1_000);
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.once("timeout", () => finish(false));
    });
  }

  private track(
    sandboxId: string,
    service: ServiceCommand,
    containerId: string,
    endpoints: ServiceEndpoint[]
  ) {
    const current = this.activeContainers.get(sandboxId) || new Map<string, ActiveService>();
    current.set(service.id, { service, containerId, endpoints });
    this.activeContainers.set(sandboxId, current);
  }

  private aggregate(
    success: boolean,
    services: StartedService[],
    environment: Record<string, string>
  ): ServiceStartupResult {
    return {
      success,
      services,
      endpoints: services.flatMap((service) => service.endpoints),
      environment,
      log: services.map((service) => `[${service.serviceId}]\n${service.log}`).join("\n")
    };
  }

  private async persistService(
    sandboxId: string,
    service: ServiceCommand,
    port: number,
    status: string
  ) {
    if (this.dbFallback) return;
    try {
      await prisma.sandboxService.create({
        data: {
          sandboxId,
          name: service.name,
          port,
          status
        }
      });
    } catch (error) {
      logger.warn({ error, sandboxId, serviceId: service.id }, "Failed to persist SandboxService");
    }
  }
}

function normalizeLegacyService(service: ServiceCommandInput): ServiceCommand {
  return {
    kind: "application",
    source: "root",
    workingDirectory: ".",
    dependsOn: [],
    environment: {},
    restartAttempts: 0,
    evidence: [],
    ...service
  };
}
