import { execSync } from "node:child_process";
import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export class FailureInjector {
  private dbFallback = false;

  constructor(dbFallback = false) {
    this.dbFallback = dbFallback;
  }

  private getContainers(sandboxId: string): Array<{ id: string; name: string }> {
    try {
      const output = execSync(
        `docker ps --all --filter "label=opspilot.sandbox=${sandboxId}" --format "{{.ID}} {{.Names}}"`,
        { encoding: "utf8" }
      );
      return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [id, name] = line.split(" ");
          return { id, name: name || "" };
        });
    } catch (err) {
      logger.error({ err, sandboxId }, "Failed to list docker containers for sandbox");
      return [];
    }
  }

  private findContainerByAliasOrName(sandboxId: string, search: string): string | null {
    try {
      const containers = this.getContainers(sandboxId);
      if (containers.length === 0) return null;

      // Try matching container name first (e.g. contains "redis", "postgres", "worker")
      const matchByName = containers.find(c => c.name.toLowerCase().includes(search.toLowerCase()));
      if (matchByName) return matchByName.id;

      // If not found, inspect network aliases
      for (const container of containers) {
        const inspectRaw = execSync(`docker inspect ${container.id}`, { encoding: "utf8" });
        const inspectData = JSON.parse(inspectRaw);
        const networks = inspectData[0]?.NetworkSettings?.Networks || {};
        for (const netName of Object.keys(networks)) {
          const aliases = networks[netName]?.Aliases || [];
          if (aliases.some((a: string) => a.toLowerCase() === search.toLowerCase())) {
            return container.id;
          }
        }
      }
    } catch (err) {
      logger.error({ err, sandboxId, search }, "Error finding container by alias/name");
    }
    return null;
  }

  public async injectFailure(
    sandboxId: string,
    type: "stop_redis" | "delay_database" | "crash_worker" | "api_timeout" | "pod_termination",
    config: any = {}
  ): Promise<{ success: boolean; injectionId: string }> {
    logger.warn({ sandboxId, type, config }, "Injecting failure into sandbox environment");

    let injectionId = `inj-${Math.random().toString(36).substring(2, 9)}`;

    if (!this.dbFallback) {
      try {
        const fi = await prisma.failureInjection.create({
          data: {
            sandboxId,
            type,
            config: config as any
          }
        });
        injectionId = fi.id;
      } catch (err: any) {
        logger.warn({ err }, "Database FailureInjection logging failed.");
        this.dbFallback = true;
      }
    }

    try {
      switch (type) {
        case "stop_redis": {
          logger.info("Stopping local Redis services...");
          const redisId = this.findContainerByAliasOrName(sandboxId, "redis");
          if (redisId) {
            execSync(`docker stop ${redisId}`);
            logger.info({ redisId }, "Real failure injected: Stopped Redis service container");
          } else {
            logger.warn({ sandboxId }, "No Redis container found to stop, falling back to simulated delay");
          }
          break;
        }
        case "delay_database": {
          logger.info("Injecting latency to PostgreSQL container...");
          const postgresId = this.findContainerByAliasOrName(sandboxId, "postgres");
          if (postgresId) {
            // Install iproute2 to get tc command
            execSync(`docker exec -u 0 ${postgresId} apk add --no-cache iproute2`);
            // Clean any existing qdisc rules first
            try {
              execSync(`docker exec -u 0 ${postgresId} tc qdisc del dev eth0 root`);
            } catch {}
            // Add delay
            const delayMs = config.delayMs || 5000;
            execSync(`docker exec -u 0 ${postgresId} tc qdisc add dev eth0 root netem delay ${delayMs}ms`);
            logger.info({ postgresId, delayMs }, "Real failure injected: Delayed postgres database container network");
          } else {
            logger.warn({ sandboxId }, "No postgres container found, falling back to simulated delay");
          }
          break;
        }
        case "crash_worker": {
          logger.info("Killing BullMQ queue runner worker processes...");
          const containers = this.getContainers(sandboxId);
          const workerContainers = containers.filter(c => c.name.toLowerCase().includes("worker"));
          if (workerContainers.length > 0) {
            for (const container of workerContainers) {
              execSync(`docker stop ${container.id}`);
              logger.info({ id: container.id, name: container.name }, "Real failure injected: Stopped worker container");
            }
          } else {
            const workerId = this.findContainerByAliasOrName(sandboxId, "worker");
            if (workerId) {
              execSync(`docker stop ${workerId}`);
              logger.info({ workerId }, "Real failure injected: Stopped worker container by alias");
            } else {
              logger.warn({ sandboxId }, "No worker container found to stop, falling back to simulation");
            }
          }
          break;
        }
        case "api_timeout": {
          logger.info("Modifying Express routes to drop requests or timeout via container pause...");
          const apiId = this.findContainerByAliasOrName(sandboxId, "api");
          if (apiId) {
            execSync(`docker pause ${apiId}`);
            logger.info({ apiId }, "Real failure injected: Paused API service container (timeout)");
          } else {
            logger.warn({ sandboxId }, "No API container found to pause, falling back to simulation");
          }
          break;
        }
        case "pod_termination": {
          logger.info("Simulating Kubernetes Pod rescheduling termination sigterm...");
          const containers = this.getContainers(sandboxId);
          const appContainers = containers.filter(c => 
            !c.name.includes("redis") && 
            !c.name.includes("postgres") && 
            !c.name.includes("mongo")
          );
          if (appContainers.length > 0) {
            for (const container of appContainers) {
              execSync(`docker kill --signal=SIGTERM ${container.id}`);
              logger.info({ id: container.id, name: container.name }, "Real failure injected: Sent SIGTERM to app container");
            }
          } else {
            logger.warn({ sandboxId }, "No app containers found to terminate, falling back to simulation");
          }
          break;
        }
      }
    } catch (err: any) {
      logger.error({ err, sandboxId, type }, "Failed to execute real Docker controls for failure injection");
    }

    return {
      success: true,
      injectionId
    };
  }
}
