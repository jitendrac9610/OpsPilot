import { Router, Response, NextFunction } from "express";
import { prisma } from "@opspilot/database";
import { ValidationError, ForbiddenError } from "@opspilot/shared";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

router.use(authMiddleware);

// GET /api/audit-logs
router.get("/", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    if (!orgId) throw new ValidationError("x-organization-id header is required");

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId: orgId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    const logs = await prisma.auditLog.findMany({
      where: { orgId },
      orderBy: { timestamp: "desc" }
    });

    res.status(200).json(logs);
  } catch (err) {
    next(err);
  }
});

export const auditRouter: Router = router;
