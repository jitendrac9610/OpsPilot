import { Worker, Job } from "bullmq";
import { logger, config } from "@opspilot/shared";
import { AgentOrchestrator } from "@opspilot/agent-runtime";

const QUEUE_NAME = "agent-runs";

export async function startWorker() {
  logger.info({ redisUrl: config.redisUrl }, "Starting agent worker...");

  let agentWorker: Worker | undefined;
  try {
    const redisUrl = new URL(config.redisUrl);
    const connection = {
      host: redisUrl.hostname || "127.0.0.1",
      port: parseInt(redisUrl.port || "6379", 10),
      username: redisUrl.username || undefined,
      password: redisUrl.password || undefined,
      db: parseInt(redisUrl.pathname.replace("/", "") || "0", 10),
      connectTimeout: 5_000,
      maxRetriesPerRequest: null,
      enableOfflineQueue: false
    };

    agentWorker = new Worker(
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
    await agentWorker.waitUntilReady();

    agentWorker.on("completed", (job) => {
      logger.info({ jobId: job.id }, "Agent run job completed successfully");
    });

    agentWorker.on("failed", (job, err) => {
      logger.error({ jobId: job?.id, err }, "Agent run job failed with error");
    });

    return { agentWorker };
  } catch (err: any) {
    await agentWorker?.close().catch((closeErr) => {
      logger.warn({ err: closeErr }, "Failed to close agent worker after startup failure");
    });
    logger.error({ err: err.message }, "BullMQ / Redis connection failed. Agent worker cannot start.");
    throw new Error(`AGENT_QUEUE_UNAVAILABLE: ${err.message}`);
  }
}

if (process.env.NODE_ENV !== "test") {
  startWorker().catch((err) => {
    logger.error({ err }, "Failed to start agent worker");
    process.exitCode = 1;
  });
}
