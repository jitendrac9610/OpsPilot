import { Job, Worker } from "bullmq";
import os from "node:os";
import { prisma } from "@opspilot/database";
import { config, logger } from "@opspilot/shared";
import { DiagnosticWorkerError } from "./errors.js";
import {
  recordDiagnosticHeartbeat,
  startDiagnosticHeartbeat,
  startDiagnosticRunWatchdog
} from "./heartbeat.js";
import { DiagnosticRunOrchestrator } from "./orchestrator.js";

export const DIAGNOSTIC_QUEUE_NAME = "diagnostic-runs";

export function redisConnectionFromConfig() {
  const redisUrl = new URL(config.redisUrl);
  return {
    host: redisUrl.hostname || "127.0.0.1",
    port: parseInt(redisUrl.port || "6379", 10),
    username: redisUrl.username || undefined,
    password: redisUrl.password || undefined,
    db: parseInt(redisUrl.pathname.replace("/", "") || "0", 10),
    connectTimeout: 5_000,
    maxRetriesPerRequest: null,
    enableOfflineQueue: false
  };
}

export async function processDiagnosticRunJob(job: Job): Promise<{ status: string }> {
  logger.info({ jobId: job.id, data: job.data }, "Processing diagnostic run job");
  const { diagnosticRunId } = job.data;

  if (!diagnosticRunId) {
    throw new Error("Missing diagnosticRunId parameter for diagnostic run job");
  }

  const attempt = job.attemptsMade + 1;
  const workerId = `diagnostic-worker-${os.hostname()}-${process.pid}-${job.id || diagnosticRunId}`;
  const abortController = new AbortController();
  const existingRun = await prisma.diagnosticRun.findUnique({
    where: { id: diagnosticRunId },
    select: { status: true }
  });
  if (!existingRun) {
    throw new DiagnosticWorkerError(
      "DIAGNOSTIC_RUN_NOT_FOUND",
      `DiagnosticRun ${diagnosticRunId} not found`,
      false
    );
  }
  if (["CANCELLED", "COMPLETED", "FAILED"].includes(existingRun.status)) {
    logger.info({ diagnosticRunId, status: existingRun.status }, "Diagnostic run already reached a final state");
    return { status: existingRun.status };
  }

  const heartbeat = startDiagnosticHeartbeat({
    runId: diagnosticRunId,
    workerId,
    signal: abortController.signal,
    onCancelled: () => abortController.abort()
  });

  await prisma.diagnosticRun.update({
    where: { id: diagnosticRunId },
    data: {
      status: "RUNNING",
      attempt,
      workerId,
      startedAt: new Date(),
      lastHeartbeatAt: new Date(),
      failureCode: null,
      failureMessage: null,
      retryable: false
    }
  });

  const orchestrator = new DiagnosticRunOrchestrator(diagnosticRunId);
  try {
    await orchestrator.run({
      signal: abortController.signal,
      attempt,
      workerId
    });

    const finalRun = await prisma.diagnosticRun.findUnique({
      where: { id: diagnosticRunId },
      select: { status: true, progress: true }
    });
    if (finalRun?.status === "COMPLETED" || finalRun?.status === "FAILED") {
      await recordDiagnosticHeartbeat(
        diagnosticRunId,
        workerId,
        finalRun.status === "COMPLETED" ? 100 : finalRun.progress
      );
    }

    logger.info({ jobId: job.id, diagnosticRunId, status: finalRun?.status }, "Finished processing diagnostic run job");
    return { status: finalRun?.status || "done" };
  } catch (err: any) {
    if (abortController.signal.aborted || err?.code === "DIAGNOSTIC_RUN_CANCELLED") {
      await prisma.diagnosticRun.update({
        where: { id: diagnosticRunId },
        data: {
          status: "CANCELLED",
          failureCode: "CANCELLED_BY_USER",
          failureMessage: "Diagnostic run was cancelled while the worker was running.",
          retryable: false,
          completedAt: new Date()
        }
      }).catch((dbErr) => {
        logger.warn({ err: dbErr, diagnosticRunId }, "Failed to persist diagnostic cancellation");
      });
      return { status: "CANCELLED" };
    }

    const diagnosticError = err instanceof DiagnosticWorkerError ? err : undefined;
    await prisma.diagnosticRun.update({
      where: { id: diagnosticRunId },
      data: {
        status: "FAILED",
        stage: "FINISHED",
        failureCode: diagnosticError?.code || "WORKER_EXECUTION_FAILED",
        failureMessage: err instanceof Error ? err.message : String(err),
        retryable: diagnosticError?.retryable ?? true,
        completedAt: new Date()
      }
    }).catch((dbErr) => {
      logger.error({ err: dbErr, diagnosticRunId }, "Failed to persist diagnostic worker failure");
    });
    throw err;
  } finally {
    heartbeat.stop();
  }
}

export async function startDiagnosticWorker() {
  startDiagnosticRunWatchdog();
  const worker = new Worker(
    DIAGNOSTIC_QUEUE_NAME,
    processDiagnosticRunJob,
    {
      connection: redisConnectionFromConfig(),
      concurrency: 2,
      lockDuration: 60_000,
      stalledInterval: 30_000,
      maxStalledCount: 1
    }
  );

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "Diagnostic run job completed successfully");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Diagnostic run job failed with error");
  });

  logger.info({ queue: DIAGNOSTIC_QUEUE_NAME }, "Diagnostic worker started");
  return worker;
}
