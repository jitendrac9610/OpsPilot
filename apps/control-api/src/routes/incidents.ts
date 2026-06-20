import { Router, Response, NextFunction } from "express";
import { prisma } from "@opspilot/database";
import { ValidationError, ForbiddenError } from "@opspilot/shared";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

router.use(authMiddleware);

// GET /api/incidents
router.get("/", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    if (!orgId) throw new ValidationError("x-organization-id header is required");

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId: orgId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    const incidents = await prisma.incident.findMany({
      orderBy: { firstDetectedAt: "desc" }
    });

    res.status(200).json(incidents);
  } catch (err) {
    next(err);
  }
});

// GET /api/incidents/:id
router.get("/:id", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    if (!orgId) throw new ValidationError("x-organization-id header is required");

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId: orgId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    const incident = await prisma.incident.findUnique({
      where: { id: req.params.id }
    });

    if (!incident) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Incident not found" });
    }

    res.status(200).json(incident);
  } catch (err) {
    next(err);
  }
});

// GET /api/incidents/:id/timeline
router.get("/:id/timeline", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    if (!orgId) throw new ValidationError("x-organization-id header is required");

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId: orgId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    const events = await prisma.incidentEvent.findMany({
      where: { incidentId: req.params.id },
      orderBy: { timestamp: "asc" }
    });

    res.status(200).json(events);
  } catch (err) {
    next(err);
  }
});

// POST /api/incidents/:id/comments
router.post("/:id/comments", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    if (!orgId) throw new ValidationError("x-organization-id header is required");

    const { comment } = req.body;
    if (!comment) throw new ValidationError("comment field is required");

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId: orgId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    const event = await prisma.incidentEvent.create({
      data: {
        incidentId: req.params.id,
        type: "COMMENT",
        message: comment
      }
    });

    res.status(201).json(event);
  } catch (err) {
    next(err);
  }
});

// POST /api/incidents/:id/investigate
router.post("/:id/investigate", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const orgId = req.organizationId;
    if (!orgId) throw new ValidationError("x-organization-id header is required");

    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId: orgId, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    const incident = await prisma.incident.findUnique({
      where: { id: req.params.id }
    });

    if (!incident) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Incident not found" });
    }

    // Update incident status
    const updatedIncident = await prisma.incident.update({
      where: { id: req.params.id },
      data: { status: "INVESTIGATING" }
    });

    // Log action to timeline
    await prisma.incidentEvent.create({
      data: {
        incidentId: req.params.id,
        type: "AGENT_TRIGGERED",
        message: `OpsPilot agent investigation manually triggered by user ${req.user!.email}`
      }
    });

    res.status(200).json({ status: "success", incident: updatedIncident });
  } catch (err) {
    next(err);
  }
});

export const incidentRouter: Router = router;
