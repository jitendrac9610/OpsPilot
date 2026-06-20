import { Router, Response, NextFunction } from "express";
import { prisma } from "@opspilot/database";
import { ValidationError, ForbiddenError } from "@opspilot/shared";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

router.use(authMiddleware);

// GET /api/usage
router.get("/usage", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    if (!orgId) throw new ValidationError("x-organization-id header is required");

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId: orgId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    const records = await prisma.usageRecord.findMany({
      where: { orgId }
    });

    res.status(200).json(records);
  } catch (err) {
    next(err);
  }
});

// GET /api/billing
router.get("/billing", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    if (!orgId) throw new ValidationError("x-organization-id header is required");

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId: orgId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    const subscription = await prisma.subscription.findUnique({
      where: { orgId }
    });

    res.status(200).json(subscription || { orgId, planId: "free", status: "active" });
  } catch (err) {
    next(err);
  }
});

// POST /api/subscriptions
router.post("/subscriptions", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    const { planId } = req.body;
    if (!orgId) throw new ValidationError("x-organization-id header is required");
    if (!planId) throw new ValidationError("planId is required");

    // Auth Check: Admin only
    const membership = await prisma.membership.findFirst({
      where: { organizationId: orgId, userId: req.user!.id },
      include: { role: true }
    });
    if (!membership || membership.role.name !== "ADMIN") {
      throw new ForbiddenError("Only organization admins can upgrade subscriptions");
    }

    const subscription = await prisma.subscription.upsert({
      where: { orgId },
      update: { planId, status: "active" },
      create: { orgId, planId, status: "active" }
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        orgId,
        userId: req.user!.id,
        action: "org.subscription.upgrade",
        payload: { planId }
      }
    });

    res.status(200).json(subscription);
  } catch (err) {
    next(err);
  }
});

export const billingRouter: Router = router;
