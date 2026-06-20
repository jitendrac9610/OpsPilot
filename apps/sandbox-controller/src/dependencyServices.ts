import crypto from "node:crypto";
import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";
import { ContainerRunner } from "./containerRunner.js";
import { DependencyService } from "./executionManifest.js";

interface DependencyDefinition {
  image: string;
  user: string;
  alias: string;
  command: string[];
  containerEnvironment: Record<string, string>;
  applicationEnvironment: Record<string, string>;
  readinessCommand: string[];
}

export interface ProvisionedDependency {
  type: DependencyService["type"];
  containerId: string;
  alias: string;
}

export interface DependencyProvisionResult {
  success: boolean;
  services: ProvisionedDependency[];
  environment: Record<string, string>;
  log: string;
}

export class DependencyServiceManager {
  private readonly activeContainers = new Map<string, string[]>();

  constructor(
    private readonly dbFallback = false,
    private readonly runner = new ContainerRunner()
  ) {}

  public async provision(
    sandboxId: string,
    network: string,
    services: DependencyService[]
  ): Promise<DependencyProvisionResult> {
    const provisioned: ProvisionedDependency[] = [];
    const environment: Record<string, string> = {};
    const logs: string[] = [];

    for (const service of services.filter((candidate) => candidate.required)) {
      const definition = this.definitionFor(service.type);
      const result = await this.runner.startDetached({
        sandboxId,
        command: definition.command,
        image: definition.image,
        user: definition.user,
        network,
        networkAliases: [definition.alias],
        environment: definition.containerEnvironment
      });
      logs.push(`[${service.type}] ${result.log}`);

      if (!result.success || !result.containerId) {
        await this.stopAll(sandboxId);
        return {
          success: false,
          services: provisioned,
          environment,
          log: `${logs.join("\n")}\nDEPENDENCY_SERVICE_START_FAILED: ${service.type}`
        };
      }

      this.track(sandboxId, result.containerId);
      const healthy = await this.waitUntilHealthy(result.containerId, definition.readinessCommand);
      await this.persistService(sandboxId, service.type, healthy ? "RUNNING" : "UNHEALTHY");
      if (!healthy) {
        await this.stopAll(sandboxId);
        return {
          success: false,
          services: provisioned,
          environment,
          log: `${logs.join("\n")}\nDEPENDENCY_SERVICE_READINESS_FAILED: ${service.type}`
        };
      }

      provisioned.push({ type: service.type, containerId: result.containerId, alias: definition.alias });
      Object.assign(environment, definition.applicationEnvironment);
    }

    return { success: true, services: provisioned, environment, log: logs.join("\n") };
  }

  public async stopAll(sandboxId: string): Promise<void> {
    const containers = this.activeContainers.get(sandboxId) || [];
    await Promise.all(containers.map((containerId) => this.runner.stop(containerId).catch(() => undefined)));
    this.activeContainers.delete(sandboxId);
  }

  private definitionFor(type: DependencyService["type"]): DependencyDefinition {
    const password = crypto.randomBytes(24).toString("base64url");
    if (type === "postgresql") {
      return {
        image: "postgres:16-alpine",
        user: "postgres",
        alias: "postgres",
        command: ["postgres"],
        containerEnvironment: {
          POSTGRES_USER: "opspilot",
          POSTGRES_PASSWORD: password,
          POSTGRES_DB: "app"
        },
        applicationEnvironment: {
          DATABASE_URL: `postgresql://opspilot:${password}@postgres:5432/app`,
          POSTGRES_URL: `postgresql://opspilot:${password}@postgres:5432/app`,
          PGHOST: "postgres",
          PGPORT: "5432",
          PGUSER: "opspilot",
          PGPASSWORD: password,
          PGDATABASE: "app"
        },
        readinessCommand: ["pg_isready", "-U", "opspilot", "-d", "app"]
      };
    }
    if (type === "redis") {
      return {
        image: "redis:7-alpine",
        user: "redis",
        alias: "redis",
        command: ["redis-server", "--save", "", "--appendonly", "no"],
        containerEnvironment: {},
        applicationEnvironment: {
          REDIS_URL: "redis://redis:6379",
          REDIS_HOST: "redis",
          REDIS_PORT: "6379"
        },
        readinessCommand: ["redis-cli", "ping"]
      };
    }
    return {
      image: "mongo:7",
      user: "mongodb",
      alias: "mongodb",
      command: ["mongod", "--bind_ip_all"],
      containerEnvironment: {},
      applicationEnvironment: {
        MONGODB_URI: "mongodb://mongodb:27017/app",
        MONGO_URL: "mongodb://mongodb:27017/app"
      },
      readinessCommand: ["mongosh", "--quiet", "--eval", "quit(db.runCommand({ ping: 1 }).ok ? 0 : 1)"]
    };
  }

  private track(sandboxId: string, containerId: string) {
    const current = this.activeContainers.get(sandboxId) || [];
    current.push(containerId);
    this.activeContainers.set(sandboxId, current);
  }

  private async waitUntilHealthy(containerId: string, command: string[]): Promise<boolean> {
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await this.runner.exec(containerId, command, 5_000);
      if (result.success) return true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  }

  private async persistService(sandboxId: string, name: string, status: string) {
    if (this.dbFallback) return;
    try {
      await prisma.sandboxService.create({
        data: { sandboxId, name, port: 0, status }
      });
    } catch (error) {
      logger.warn({ error, sandboxId, name }, "Failed to persist dependency SandboxService");
    }
  }
}
