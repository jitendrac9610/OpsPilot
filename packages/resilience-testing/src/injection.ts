import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export class FailureInjector {
  private dbFallback = false;

  constructor(dbFallback = false) {
    this.dbFallback = dbFallback;
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

    switch (type) {
      case "stop_redis":
        logger.info("Simulation: Stopping local Redis services...");
        break;
      case "delay_database":
        logger.info("Simulation: Injecting 5000ms latency to PostgreSQL connection pool query executor...");
        break;
      case "crash_worker":
        logger.info("Simulation: Killing BullMQ queue runner worker processes...");
        break;
      case "api_timeout":
        logger.info("Simulation: Modifying Express routes to drop requests or timeout...");
        break;
      case "pod_termination":
        logger.info("Simulation: Simulating Kubernetes Pod rescheduling termination sigterm...");
        break;
    }

    return {
      success: true,
      injectionId
    };
  }
}
