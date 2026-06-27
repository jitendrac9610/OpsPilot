import { logger } from "@opspilot/shared";
import { startDiagnosticWorker } from "./worker.js";

export * from "./orchestrator.js";
export * from "./worker.js";

if (process.env.NODE_ENV !== "test") {
  startDiagnosticWorker().catch((err) => {
    logger.error({ err }, "Failed to start diagnostic worker");
    process.exitCode = 1;
  });
}
