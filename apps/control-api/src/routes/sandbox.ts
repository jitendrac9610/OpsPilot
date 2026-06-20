import { Router, Response, NextFunction } from "express";
import { prisma } from "@opspilot/database";
import { config, ForbiddenError, OpsPilotError, ValidationError } from "@opspilot/shared";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();
router.use(authMiddleware);

async function controllerRequest(path: string, init?: RequestInit) {
  const response = await fetch(`${config.services.sandboxControllerUrl}${path}`, init);
  const text = await response.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }

  if (!response.ok) {
    throw new OpsPilotError(
      body.message || "Sandbox controller request failed.",
      body.error || "SANDBOX_CONTROLLER_ERROR",
      response.status,
      body
    );
  }
  return body;
}

export function repositoryOwnershipWhere(userId: string, repositoryId: string, organizationId?: string) {
  return {
    id: repositoryId,
    project: {
      ...(organizationId ? { organizationId } : {}),
      organization: {
        memberships: { some: { userId } }
      }
    }
  };
}

export function sandboxOwnershipWhere(userId: string, sandboxId: string, organizationId?: string) {
  return {
    id: sandboxId,
    snapshot: {
      repository: {
        project: {
          ...(organizationId ? { organizationId } : {}),
          organization: {
            memberships: { some: { userId } }
          }
        }
      }
    }
  };
}

async function requireOwnedRepository(req: AuthenticatedRequest, repositoryId: string) {
  const repository = await prisma.repository.findFirst({
    where: repositoryOwnershipWhere(req.user!.id, repositoryId, req.organizationId),
    include: { project: true }
  });
  if (!repository) throw new ForbiddenError("Repository is not accessible");
  return repository;
}

async function requireOwnedSandbox(req: AuthenticatedRequest, sandboxId: string) {
  const sandbox = await prisma.sandbox.findFirst({
    where: sandboxOwnershipWhere(req.user!.id, sandboxId, req.organizationId)
  });
  if (!sandbox) throw new ForbiddenError("Sandbox is not accessible");
  return sandbox;
}

// Allocate and hydrate the latest real repository snapshot.
router.post("/", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { repositoryId } = req.body;
    if (!repositoryId) throw new ValidationError("repositoryId is required");
    const repo = await requireOwnedRepository(req, repositoryId);

    const snapshot = await prisma.repositorySnapshot.findFirst({
      where: { repositoryId },
      orderBy: { createdAt: "desc" }
    });
    if (!snapshot) {
      throw new OpsPilotError(
        "No repository snapshot exists yet. Finish snapshot creation and indexing before starting Runtime Lab.",
        "SNAPSHOT_NOT_FOUND",
        409
      );
    }

    const sandbox = await controllerRequest("/api/sandboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshotId: snapshot.id })
    });

    await prisma.auditLog.create({
      data: {
        orgId: repo.project.organizationId,
        userId: req.user!.id,
        action: "sandbox.create",
        payload: {
          sandboxId: sandbox.id,
          repositoryId,
          snapshotId: snapshot.id,
          commitSha: snapshot.commitSha,
          repoName: repo?.name || ""
        }
      }
    });

    res.status(201).json({
      ...sandbox,
      services: [],
      demoData: config.isDemoMode
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const sandboxId = req.params.id;
    const sandbox = await requireOwnedSandbox(req, sandboxId);

    const [services, buildRuns, testRuns, loadRuns, failures] = await Promise.all([
      prisma.sandboxService.findMany({ where: { sandboxId } }),
      prisma.buildRun.findMany({ where: { sandboxId }, orderBy: { createdAt: "desc" } }),
      prisma.testRun.findMany({ where: { sandboxId }, orderBy: { createdAt: "desc" } }),
      prisma.loadTestRun.findMany({ where: { sandboxId }, orderBy: { createdAt: "desc" } }),
      prisma.failureInjection.findMany({ where: { sandboxId }, orderBy: { createdAt: "desc" } })
    ]);

    res.json({ ...sandbox, services, buildRuns, testRuns, loadRuns, failures, demoData: config.isDemoMode });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/build", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await requireOwnedSandbox(req, req.params.id);
    const result = await controllerRequest(`/api/sandboxes/${req.params.id}/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/:id/install", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await requireOwnedSandbox(req, req.params.id);
    const result = await controllerRequest(`/api/sandboxes/${req.params.id}/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/:id/run", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await requireOwnedSandbox(req, req.params.id);
    const result = await controllerRequest(`/api/sandboxes/${req.params.id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environment: req.body.environment || {} })
    });
    res.status(result.success ? 200 : 422).json(result);
  } catch (error) {
    if (error instanceof OpsPilotError && error.details) {
      return res.status(error.statusCode).json(error.details);
    }
    next(error);
  }
});

router.post("/:id/start", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await requireOwnedSandbox(req, req.params.id);
    const { serviceId, environment } = req.body;
    if (!serviceId) throw new ValidationError("serviceId is required");
    const result = await controllerRequest(`/api/sandboxes/${req.params.id}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serviceId, environment })
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/:id/test", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await requireOwnedSandbox(req, req.params.id);
    const { type } = req.body;
    const result = await controllerRequest(`/api/sandboxes/${req.params.id}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type })
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await requireOwnedSandbox(req, req.params.id);
    const result = await controllerRequest(`/api/sandboxes/${req.params.id}`, { method: "DELETE" });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/:id/inject-failure", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await requireOwnedSandbox(req, req.params.id);
    if (!config.isDemoMode) {
      throw new OpsPilotError(
        "Real failure injection is not implemented for the isolated runner yet.",
        "FAILURE_INJECTION_NOT_IMPLEMENTED",
        501
      );
    }

    const { type, serviceName, config: injectionConfig } = req.body;
    const injection = await prisma.failureInjection.create({
      data: {
        sandboxId: req.params.id,
        type: type || "latency",
        config: {
          ...(injectionConfig || {}),
          targetService: serviceName || "application",
          simulated: true
        }
      }
    });
    res.json({ ...injection, simulated: true, demoData: true });
  } catch (error) {
    next(error);
  }
});

router.post("/:id/load-test", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    await requireOwnedSandbox(req, req.params.id);
    if (!config.isDemoMode) {
      throw new OpsPilotError(
        "A real HTTP load driver has not been configured for this sandbox.",
        "LOAD_TEST_NOT_IMPLEMENTED",
        501
      );
    }

    const loadRun = await prisma.loadTestRun.create({
      data: {
        sandboxId: req.params.id,
        throughput: 175,
        latencyP95: 160,
        errorRate: 0.01
      }
    });
    res.json({ ...loadRun, simulated: true, demoData: true });
  } catch (error) {
    next(error);
  }
});

export const sandboxRouter: Router = router;
