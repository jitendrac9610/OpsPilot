import { Worker, Job } from "bullmq";
import { logger, config } from "@opspilot/shared";
import { AgentOrchestrator } from "@opspilot/agent-runtime";

const QUEUE_NAME = "agent-runs";

export async function startWorker() {
  logger.info({ redisUrl: config.redisUrl }, "Starting agent and diagnostic workers...");

  try {
    const redisUrl = new URL(config.redisUrl);
    const connection = {
      host: redisUrl.hostname || "127.0.0.1",
      port: parseInt(redisUrl.port || "6379", 10),
      username: redisUrl.username || undefined,
      password: redisUrl.password || undefined,
      db: parseInt(redisUrl.pathname.replace("/", "") || "0", 10)
    };

    const agentWorker = new Worker(
      "agent-runs",
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

    agentWorker.on("completed", (job) => {
      logger.info({ jobId: job.id }, "Agent run job completed successfully");
    });

    agentWorker.on("failed", (job, err) => {
      logger.error({ jobId: job?.id, err }, "Agent run job failed with error");
    });

    const diagnosticWorker = new Worker(
      "diagnostic-runs",
      async (job: Job) => {
        logger.info({ jobId: job.id, data: job.data }, "Processing diagnostic run job");
        const { diagnosticRunId } = job.data;

        if (!diagnosticRunId) {
          throw new Error("Missing diagnosticRunId parameter for diagnostic run job");
        }

        const { DiagnosticRunOrchestrator } = await import("@opspilot/workflow-engine");
        const orchestrator = new DiagnosticRunOrchestrator(diagnosticRunId);
        await orchestrator.run();

        logger.info({ jobId: job.id, diagnosticRunId }, "Finished processing diagnostic run job");
        return { status: "done" };
      },
      { connection }
    );

    diagnosticWorker.on("completed", (job) => {
      logger.info({ jobId: job.id }, "Diagnostic run job completed successfully");
    });

    diagnosticWorker.on("failed", (job, err) => {
      logger.error({ jobId: job?.id, err }, "Diagnostic run job failed with error");
    });

    return { agentWorker, diagnosticWorker };
  } catch (err: any) {
    logger.warn({ err: err.message }, "BullMQ / Redis connection failed. Workers running in fallback mock mode.");
    return null;
  }
}

if (process.env.NODE_ENV !== "test") {
  startWorker().catch((err) => {
    logger.error({ err }, "Failed to start agent worker");
  });
}
