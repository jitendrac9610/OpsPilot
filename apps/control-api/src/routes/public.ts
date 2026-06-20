import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@opspilot/database";
import { ValidationError, ForbiddenError, logger } from "@opspilot/shared";

const router = Router();

// Middleware to authenticate via x-api-key header
const apiKeyMiddleware = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const apiKey = req.headers["x-api-key"] as string;
    if (!apiKey) {
      throw new ValidationError("x-api-key header is required");
    }

    // Lookup public API key in EncryptedSecret
    const secret = await prisma.encryptedSecret.findFirst({
      where: { key: "public_api_key", value: apiKey }
    });

    if (!secret) {
      throw new ForbiddenError("Invalid API key provided");
    }

    // Attach orgId to the request context
    (req as any).organizationId = secret.orgId;
    next();
  } catch (err) {
    next(err);
  }
};

router.use(apiKeyMiddleware);

// POST /api/public/repositories/:id/index
router.post("/repositories/:id/index", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = (req as any).organizationId;

    const repository = await prisma.repository.findUnique({
      where: { id },
      include: { project: true }
    });

    if (!repository || repository.project.organizationId !== orgId) {
      throw new ValidationError("Repository not found in organization");
    }

    const mockWebhookUrl = `http://localhost:4001/webhooks/github`;
    fetch(mockWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push"
      },
      body: JSON.stringify({
        ref: `refs/heads/${repository.branch}`,
        head_commit: { id: `public_api_trigger_${Date.now()}` },
        repository: { id: repository.id, clone_url: repository.gitUrl }
      })
    }).catch(err => logger.error({ err }, "Failed to send manual push index trigger from public API"));

    res.status(202).json({ status: "indexing_initiated", repositoryId: id });
  } catch (err) {
    next(err);
  }
});

// GET /api/public/repositories/:id/findings
router.get("/repositories/:id/findings", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = (req as any).organizationId;

    const repository = await prisma.repository.findUnique({
      where: { id },
      include: { project: true }
    });

    if (!repository || repository.project.organizationId !== orgId) {
      throw new ValidationError("Repository not found in organization");
    }

    const findings = await prisma.finding.findMany({
      where: { repositoryId: id }
    });

    res.status(200).json(findings);
  } catch (err) {
    next(err);
  }
});

// GET /api/public/incidents/:id
router.get("/incidents/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const orgId = (req as any).organizationId;

    const incident = await prisma.incident.findUnique({
      where: { id }
    });

    if (!incident) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Incident not found" });
    }

    res.status(200).json(incident);
  } catch (err) {
    next(err);
  }
});

export const publicRouter: Router = router;
