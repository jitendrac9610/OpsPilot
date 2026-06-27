import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

const STAGE_PROGRESS: Record<string, number> = {
  CLONING: 5,
  DISCOVERING: 15,
  INDEXING: 25,
  SANDBOX_PROVISION: 35,
  SANDBOX_START: 45,
  BOOTSTRAP_AUTH: 55,
  PLANNING_WORKFLOW: 65,
  EXECUTING_WORKFLOW: 75,
  LOCALIZING_FAILURE: 85,
  FINISHED: 100
};

export function progressForStage(stage: string): number {
  return STAGE_PROGRESS[stage] ?? 0;
}

export async function recordDiagnosticHeartbeat(
  runId: string,
  workerId: string,
  progress?: number
): Promise<void> {
  const run = await prisma.diagnosticRun.findUnique({
    where: { id: runId },
    select: { stage: true, progress: true }
  });
  if (!run) return;

  await prisma.diagnosticRun.update({
    where: { id: runId },
    data: {
      lastHeartbeatAt: new Date(),
      workerId,
      progress: progress ?? Math.max(run.progress, progressForStage(run.stage))
    }
  });
}

export interface DiagnosticHeartbeatController {
  stop(): void;
}

export function startDiagnosticHeartbeat(options: {
  runId: string;
  workerId: string;
  intervalMs?: number;
  signal?: AbortSignal;
  onCancelled?: () => void;
}): DiagnosticHeartbeatController {
  const intervalMs = options.intervalMs ?? 15_000;
  let stopped = false;

  const beat = async () => {
    if (stopped || options.signal?.aborted) return;
    try {
      const run = await prisma.diagnosticRun.findUnique({
        where: { id: options.runId },
        select: { status: true, stage: true, progress: true }
      });

      if (!run || ["COMPLETED", "FAILED"].includes(run.status)) {
        stopped = true;
        return;
      }

      if (run.status === "CANCELLED") {
        options.onCancelled?.();
        stopped = true;
        return;
      }

      await prisma.diagnosticRun.update({
        where: { id: options.runId },
        data: {
          lastHeartbeatAt: new Date(),
          workerId: options.workerId,
          progress: Math.max(run.progress, progressForStage(run.stage))
        }
      });
    } catch (err) {
      logger.warn({ err, runId: options.runId }, "Failed to write diagnostic heartbeat");
    }
  };

  void beat();
  const timer = setInterval(() => void beat(), intervalMs);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}

export async function markStalledDiagnosticRuns(
  timeoutMs: number,
  options: { repositoryId?: string } = {}
): Promise<number> {
  const cutoff = new Date(Date.now() - timeoutMs);
  const result = await prisma.diagnosticRun.updateMany({
    where: {
      status: "RUNNING",
      repositoryId: options.repositoryId,
      OR: [
        { lastHeartbeatAt: { lt: cutoff } },
        {
          lastHeartbeatAt: null,
          updatedAt: { lt: cutoff }
        }
      ]
    },
    data: {
      status: "FAILED",
      stage: "FINISHED",
      failureCode: "WORKER_HEARTBEAT_TIMEOUT",
      failureMessage: `Diagnostic worker heartbeat timed out after ${timeoutMs}ms.`,
      retryable: true,
      completedAt: new Date()
    }
  });

  if (result.count > 0) {
    logger.warn({ count: result.count, timeoutMs }, "Marked stalled diagnostic runs as failed");
  }

  return result.count;
}

export function startDiagnosticRunWatchdog(options: {
  intervalMs?: number;
  timeoutMs?: number;
} = {}): DiagnosticHeartbeatController {
  const intervalMs = options.intervalMs ?? 30_000;
  const timeoutMs = options.timeoutMs ?? 90_000;

  const timer = setInterval(() => {
    markStalledDiagnosticRuns(timeoutMs).catch((err) => {
      logger.error({ err, timeoutMs }, "Diagnostic watchdog failed");
    });
  }, intervalMs);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
    }
  };
}
