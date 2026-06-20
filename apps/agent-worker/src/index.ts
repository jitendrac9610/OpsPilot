import { Worker, Job } from "bullmq";
import { logger, config } from "@opspilot/shared";
import { AgentOrchestrator } from "@opspilot/agent-runtime";

const QUEUE_NAME = "agent-runs";

export async function startWorker() {
  logger.info({ queue: QUEUE_NAME, redisUrl: config.redisUrl }, "Starting agent worker...");

  try {
    const redisUrl = new URL(config.redisUrl);
    const connection = {
      host: redisUrl.hostname || "127.0.0.1",
      port: parseInt(redisUrl.port || "6379", 10),
      username: redisUrl.username || undefined,
      password: redisUrl.password || undefined,
      db: parseInt(redisUrl.pathname.replace("/", "") || "0", 10)
    };

    const worker = new Worker(
      QUEUE_NAME,
      async (job: Job) => {
        logger.info({ jobId: job.id, data: job.data }, "Processing agent run job");
        const { goal, agentRunId, workflowRunId, incidentId, snapshotId, isProduction } = job.data;

        if (!goal) {
          throw new Error("Missing goal parameter for agent run job");
        }

        const orchestrator = new AgentOrchestrator({
          agentRunId,
          workflowRunId,
          incidentId,
          snapshotId,
          goal,
          isProduction
        });

        const finalState = await orchestrator.run();
        logger.info({ jobId: job.id, finalState }, "Finished processing agent run job");
        return { finalState };
      },
      { connection }
    );

    worker.on("completed", (job) => {
      logger.info({ jobId: job.id }, "Job completed successfully");
    });

    worker.on("failed", (job, err) => {
      logger.error({ jobId: job?.id, err }, "Job failed with error");
    });

    return worker;
  } catch (err: any) {
    logger.warn({ err: err.message }, "BullMQ / Redis connection failed. Worker running in fallback mock mode.");
    return null;
  }
}

if (process.env.NODE_ENV !== "test") {
  startWorker().catch((err) => {
    logger.error({ err }, "Failed to start agent worker");
  });
}
