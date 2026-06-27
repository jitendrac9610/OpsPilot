import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "@opspilot/database";
import { createCommitSnapshot, resolveRemoteHeadSha } from "@opspilot/repository-intelligence";
import { ValidationError, ForbiddenError } from "@opspilot/shared";

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

    const commitSha = await resolveRemoteHeadSha(repository.gitUrl, repository.branch);
    const snapshot = await createCommitSnapshot({
      repositoryId: repository.id,
      gitUrl: repository.gitUrl,
      commitSha,
      branch: repository.branch,
      source: "public-api"
    });

    res.status(202).json({
      status: "indexing_initiated",
      repositoryId: id,
      snapshotId: snapshot.snapshotId,
      commitSha,
      archiveHash: snapshot.archiveHash
    });
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
