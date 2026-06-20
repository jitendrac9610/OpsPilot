import { Router, Response, NextFunction } from "express";
import { prisma } from "@opspilot/database";
import { ValidationError, ForbiddenError, logger, storage } from "@opspilot/shared";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth.js";
import unzipper from "unzipper";

const router = Router();

router.use(authMiddleware);

// POST /api/projects/:projectId/repositories
router.post("/projects/:projectId/repositories", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params;
    const { name, gitUrl, branch, directory } = req.body;
    if (!name || !gitUrl) throw new ValidationError("name and gitUrl are required");

    // Fetch Project to confirm access
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new ValidationError("Project not found");

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId: project.organizationId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    // Enforce Plan Limits: Free Tier max 2 repositories
    const subscription = await prisma.subscription.findUnique({
      where: { orgId: project.organizationId }
    });
    const planId = subscription?.planId || "free";
    if (planId === "free") {
      const projectsInOrg = await prisma.project.findMany({
        where: { organizationId: project.organizationId },
        select: { id: true }
      });
      const projectIds = projectsInOrg.map(p => p.id);
      const connectedReposCount = await prisma.repository.count({
        where: { projectId: { in: projectIds } }
      });
      if (connectedReposCount >= 2) {
        throw new ValidationError("Free tier limit exceeded: maximum of 2 repositories allowed. Upgrade to Pro.");
      }
    }

    const repository = await prisma.repository.create({
      data: {
        projectId,
        name,
        gitUrl,
        branch: branch || "main",
        directory: directory || "/"
      }
    });

    // Create audit log
    await prisma.auditLog.create({
      data: {
        orgId: project.organizationId,
        userId: req.user!.id,
        action: "repository.connect",
        payload: { repositoryId: repository.id, name: repository.name }
      }
    });

    res.status(201).json(repository);
  } catch (err) {
    next(err);
  }
});

// GET /api/repositories/:id/status
router.get("/:id/status", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const repository = await prisma.repository.findUnique({
      where: { id },
      include: { project: true }
    });
    if (!repository) throw new ValidationError("Repository not found");

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId: repository.project.organizationId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    // Check latest indexing logs
    const latestSnapshot = await prisma.repositorySnapshot.findFirst({
      where: { repositoryId: id },
      orderBy: { createdAt: "desc" }
    });

    if (!latestSnapshot) {
      return res.status(200).json({ status: "UNINDEXED", latestCommit: null });
    }

    const archVersion = await prisma.architectureVersion.findFirst({
      where: { snapshotId: latestSnapshot.id }
    });

    const status = archVersion ? "INDEXED" : "INDEXING";

    res.status(200).json({
      status,
      latestCommit: latestSnapshot.commitSha,
      indexedAt: latestSnapshot.createdAt
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/repositories/:id/capabilities
router.get("/:id/capabilities", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const repository = await prisma.repository.findUnique({
      where: { id },
      include: { project: true }
    });
    if (!repository) throw new ValidationError("Repository not found");

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId: repository.project.organizationId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    const latestSnapshot = await prisma.repositorySnapshot.findFirst({
      where: { repositoryId: id },
      orderBy: { createdAt: "desc" }
    });

    if (!latestSnapshot) {
      return res.status(200).json({ profile: null });
    }

    const capProfile = await prisma.capabilityProfile.findUnique({
      where: { snapshotId: latestSnapshot.id }
    });

    // Fallback: Default TS Stack profile
    res.status(200).json(capProfile || {
      snapshotId: latestSnapshot.id,
      profile: {
        languages: ["TypeScript", "JavaScript"],
        frameworks: ["Express", "Next.js"],
        databases: ["PostgreSQL", "MongoDB"],
        messaging: ["Inngest", "Redis"],
        integrations: ["Clerk", "Stripe", "GetStream"]
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/repositories/:id/architecture
router.get("/:id/architecture", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const repository = await prisma.repository.findUnique({
      where: { id },
      include: { project: true }
    });
    if (!repository) throw new ValidationError("Repository not found");

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId: repository.project.organizationId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    const latestSnapshot = await prisma.repositorySnapshot.findFirst({
      where: { repositoryId: id },
      orderBy: { createdAt: "desc" }
    });

    if (!latestSnapshot) {
      return res.status(200).json({ nodes: [], edges: [] });
    }

    const archVersion = await prisma.architectureVersion.findFirst({
      where: { snapshotId: latestSnapshot.id },
      orderBy: { createdAt: "desc" }
    });

    if (!archVersion) {
      return res.status(200).json({ nodes: [], edges: [] });
    }

    const nodes = await prisma.graphNode.findMany({
      where: { versionId: archVersion.id }
    });

    const edges = await prisma.graphEdge.findMany({
      where: { versionId: archVersion.id }
    });

    const cleanNodes = nodes.map(node => ({
      ...node,
      id: node.id.replace(`${archVersion.id}_`, "")
    }));

    const cleanEdges = edges.map(edge => ({
      ...edge,
      id: edge.id.replace(`${archVersion.id}_`, ""),
      source: edge.source.replace(`${archVersion.id}_`, ""),
      target: edge.target.replace(`${archVersion.id}_`, "")
    }));

    res.status(200).json({ nodes: cleanNodes, edges: cleanEdges });
  } catch (err) {
    next(err);
  }
});

// GET /api/repositories/:id/findings
router.get("/:id/findings", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const repository = await prisma.repository.findUnique({
      where: { id },
      include: { project: true }
    });
    if (!repository) throw new ValidationError("Repository not found");

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId: repository.project.organizationId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    const findings = await prisma.finding.findMany({
      where: { repositoryId: id }
    });

    res.status(200).json(findings);
  } catch (err) {
    next(err);
  }
});

// POST /api/repositories/:id/index
router.post("/:id/index", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const repository = await prisma.repository.findUnique({
      where: { id },
      include: { project: true }
    });
    if (!repository) throw new ValidationError("Repository not found");

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId: repository.project.organizationId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    // Trigger mock webhook/indexing
    const mockWebhookUrl = `http://localhost:4001/webhooks/github`;
    
    // Non-blocking trigger to github-worker
    fetch(mockWebhookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-github-event": "push"
      },
      body: JSON.stringify({
        ref: `refs/heads/${repository.branch}`,
        head_commit: { id: `manual_commit_${Date.now()}` },
        repository: { id: repository.id, clone_url: repository.gitUrl }
      })
    }).catch(err => logger.error({ err }, "Failed to send manual push index trigger"));

    res.status(202).json({ status: "indexing_initiated" });
  } catch (err) {
    next(err);
  }
});

// GET /api/repositories/:id/logs
router.get("/:id/logs", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const repository = await prisma.repository.findUnique({
      where: { id },
      include: { project: true }
    });
    if (!repository) throw new ValidationError("Repository not found");

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId: repository.project.organizationId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    const logs = await prisma.auditLog.findMany({
      where: { action: "repository.index.log" },
      orderBy: { timestamp: "asc" }
    });

    const filtered = logs
      .filter(l => (l.payload as any)?.repositoryId === id)
      .map(l => (l.payload as any)?.message);

    res.status(200).json(filtered);
  } catch (err) {
    next(err);
  }
});

// GET /api/repositories/:id/file?path=...
router.get("/:id/file", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { path: filePath } = req.query;

    if (!filePath || typeof filePath !== "string") {
      throw new ValidationError("path query parameter is required");
    }

    const repository = await prisma.repository.findUnique({
      where: { id },
      include: { project: true }
    });
    if (!repository) throw new ValidationError("Repository not found");

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId: repository.project.organizationId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    const latestSnapshot = await prisma.repositorySnapshot.findFirst({
      where: { repositoryId: id },
      orderBy: { createdAt: "desc" }
    });

    if (!latestSnapshot) {
      throw new ValidationError("No snapshot indexed yet for this repository");
    }

    const zipBuffer = await storage.downloadSnapshot(latestSnapshot.archiveUrl);
    const directory = await unzipper.Open.buffer(zipBuffer);

    const cleanPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
    const file = directory.files.find(f => f.path === cleanPath || f.path === `src/${cleanPath}`);

    if (!file) {
      const fuzzyFile = directory.files.find(f => f.path.endsWith(cleanPath));
      if (!fuzzyFile) {
        return res.status(404).json({ error: "FILE_NOT_FOUND", message: `File ${filePath} not found in snapshot` });
      }
      const content = await fuzzyFile.buffer();
      return res.status(200).json({ content: content.toString() });
    }

    const content = await file.buffer();
    res.status(200).json({ content: content.toString() });
  } catch (err) {
    next(err);
  }
});

export const repositoryRouter: Router = router;
