import { Router, Response, NextFunction } from "express";
import { Queue } from "bullmq";
import { prisma } from "@opspilot/database";
import { config, ForbiddenError, ValidationError, logger } from "@opspilot/shared";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();
router.use(authMiddleware);

async function requireOwnedDiagnosticRun(req: AuthenticatedRequest, runId: string) {
  const run = await prisma.diagnosticRun.findUnique({
    where: { id: runId },
    include: {
      repository: {
        include: {
          project: {
            include: {
              organization: {
                include: {
                  memberships: true
                }
              }
            }
          }
        }
      }
    }
  });

  if (!run) {
    throw new ValidationError("Diagnostic run not found");
  }

  // Check if current user is member of the organization
  const membership = run.repository.project.organization.memberships.find(
    (m) => m.userId === req.user!.id
  );
  if (!membership) {
    throw new ForbiddenError("You do not have access to this diagnostic run");
  }

  return run;
}

export async function enqueueDiagnosticRun(diagnosticRunId: string) {
  try {
    const redisUrl = new URL(config.redisUrl);
    const connection = {
      host: redisUrl.hostname || "127.0.0.1",
      port: parseInt(redisUrl.port || "6379", 10),
      username: redisUrl.username || undefined,
      password: redisUrl.password || undefined,
      db: parseInt(redisUrl.pathname.replace("/", "") || "0", 10)
    };

    const queue = new Queue("diagnostic-runs", { connection });
    await queue.add("run-diagnosis", { diagnosticRunId });
    await queue.close();
    logger.info({ diagnosticRunId }, "Enqueued diagnostic run on BullMQ queue");
  } catch (err: any) {
    logger.warn({ err: err.message, diagnosticRunId }, "Failed to enqueue diagnostic run to Redis/BullMQ. Running worker directly if possible.");
  }
}

// GET /api/diagnostic-runs
router.get("/", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const runs = await prisma.diagnosticRun.findMany({
      where: {
        repository: {
          project: {
            organization: {
              memberships: {
                some: { userId: req.user!.id }
              }
            }
          }
        }
      },
      include: {
        repository: true
      },
      orderBy: {
        createdAt: "desc"
      }
    });
    res.status(200).json(runs);
  } catch (err) {
    next(err);
  }
});

// GET /api/diagnostic-runs/:id
router.get("/:id", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const run = await requireOwnedDiagnosticRun(req, req.params.id);
    
    // Clean memberships and nested properties from output
    const { repository, ...cleanRun } = run;

    res.status(200).json(cleanRun);
  } catch (err) {
    next(err);
  }
});

// POST /api/diagnostic-runs/:id/cancel
router.post("/:id/cancel", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const run = await requireOwnedDiagnosticRun(req, req.params.id);

    if (run.status === "COMPLETED" || run.status === "FAILED" || run.status === "CANCELLED") {
      throw new ValidationError(`Cannot cancel a diagnostic run that is already in '${run.status}' state`);
    }

    const updated = await prisma.diagnosticRun.update({
      where: { id: run.id },
      data: {
        status: "CANCELLED",
        completedAt: new Date()
      }
    });

    // Create audit log
    await prisma.auditLog.create({
      data: {
        orgId: run.repository.project.organizationId,
        userId: req.user!.id,
        action: "diagnostic_run.cancel",
        payload: { diagnosticRunId: run.id }
      }
    });

    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
});

// POST /api/diagnostic-runs/:id/retry
router.post("/:id/retry", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const run = await requireOwnedDiagnosticRun(req, req.params.id);

    if (run.status !== "FAILED" && run.status !== "CANCELLED") {
      throw new ValidationError(`Only failed or cancelled runs can be retried. Current status: ${run.status}`);
    }

    const newRun = await prisma.diagnosticRun.create({
      data: {
        repositoryId: run.repositoryId,
        status: "PENDING",
        stage: "CLONING"
      }
    });

    await prisma.auditLog.create({
      data: {
        orgId: run.repository.project.organizationId,
        userId: req.user!.id,
        action: "diagnostic_run.retry",
        payload: { originalRunId: run.id, newRunId: newRun.id }
      }
    });

    await enqueueDiagnosticRun(newRun.id);

    res.status(201).json(newRun);
  } catch (err) {
    next(err);
  }
});

export const diagnosticRunsRouter: Router = router;
