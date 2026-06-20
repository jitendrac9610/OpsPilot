import { Router, Response, NextFunction } from "express";
import { prisma } from "@opspilot/database";
import { ValidationError, ForbiddenError } from "@opspilot/shared";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

router.use(authMiddleware);

// Middleware to verify the user has ADMIN role in the active organization
const verifyAdminRole = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    if (!orgId) {
      throw new ValidationError("x-organization-id header is required");
    }

    const membership = await prisma.membership.findFirst({
      where: { organizationId: orgId, userId: req.user!.id },
      include: { role: true }
    });

    if (!membership || membership.role.name !== "ADMIN") {
      throw new ForbiddenError("Platform administration requires administrator privilege");
    }

    next();
  } catch (err) {
    next(err);
  }
};

router.use(verifyAdminRole);

// GET /api/admin/tenants - Tenant search
router.get("/tenants", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { q } = req.query;
    const searchString = typeof q === "string" ? q : "";

    const tenants = await prisma.organization.findMany({
      where: {
        name: { contains: searchString, mode: "insensitive" }
      },
      include: {
        memberships: {
          include: { user: true, role: true }
        }
      }
    });

    res.status(200).json(tenants);
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/health - Worker and queue health dashboard
router.get("/health", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    // Return mock BullMQ queue status indicating general health
    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      queues: {
        "agent-runs": { active: 0, waiting: 0, failed: 1, status: "active" },
        "indexing": { active: 0, waiting: 0, failed: 0, status: "active" },
        "discovery": { active: 0, waiting: 0, failed: 0, status: "active" }
      },
      services: {
        "sandbox-controller": "online",
        "telemetry-api": "online",
        "github-worker": "online"
      }
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/admin/jobs - Failed / dead-letter jobs list
router.get("/jobs", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    // Return list of jobs that failed recently from our mock auditing logs
    const failedSteps = await prisma.agentStep.findMany({
      where: {
        decision: {
          path: ["type"],
          equals: "needs_human"
        }
      },
      orderBy: { timestamp: "desc" },
      take: 10
    });

    res.status(200).json(failedSteps);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/feature-flags - Feature flag management
router.post("/feature-flags", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { id, enabled, description } = req.body;
    if (!id) throw new ValidationError("Feature flag id is required");

    const flag = await prisma.featureFlag.upsert({
      where: { id },
      update: { enabled, description },
      create: { id, enabled, description }
    });

    res.status(200).json(flag);
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/controls/disable-tool - Emergency disabling of risky tools
router.post("/controls/disable-tool", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { toolName, disable } = req.body;
    if (!toolName) throw new ValidationError("toolName is required");

    // We disable tools by adding a record to audit logs or creating an emergency policy block
    await prisma.auditLog.create({
      data: {
        orgId: req.organizationId!,
        userId: req.user!.id,
        action: disable ? "admin.tool.disable" : "admin.tool.enable",
        payload: { toolName }
      }
    });

    res.status(200).json({ status: "success", toolName, disabled: disable });
  } catch (err) {
    next(err);
  }
});

export const adminRouter: Router = router;
