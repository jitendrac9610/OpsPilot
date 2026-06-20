import { Router, Response, NextFunction } from "express";
import { prisma } from "@opspilot/database";
import { ValidationError, ForbiddenError } from "@opspilot/shared";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

router.use(authMiddleware);

// POST /api/projects
router.post("/", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { name } = req.body;
    const organizationId = req.organizationId || req.body.organizationId;
    if (!name) throw new ValidationError("Project name is required");
    if (!organizationId) throw new ValidationError("OrganizationId is required");

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    const project = await prisma.project.create({
      data: {
        name,
        organizationId
      }
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        orgId: organizationId,
        userId: req.user!.id,
        action: "project.create",
        payload: { projectId: project.id, projectName: project.name }
      }
    });

    res.status(201).json(project);
  } catch (err) {
    next(err);
  }
});

// GET /api/projects
router.get("/", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const organizationId = req.organizationId;
    if (!organizationId) {
      throw new ValidationError("x-organization-id header is required to retrieve projects");
    }

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    const projects = await prisma.project.findMany({
      where: { organizationId },
      include: { repositories: true }
    });

    res.status(200).json(projects);
  } catch (err) {
    next(err);
  }
});

export const projectRouter: Router = router;
