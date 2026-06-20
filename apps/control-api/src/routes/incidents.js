"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.incidentRouter = void 0;
const express_1 = require("express");
const database_1 = require("@opspilot/database");
const shared_1 = require("@opspilot/shared");
const auth_js_1 = require("../middleware/auth.js");
const router = (0, express_1.Router)();
router.use(auth_js_1.authMiddleware);
// GET /api/incidents
router.get("/", async (req, res, next) => {
    try {
        const orgId = req.organizationId;
        if (!orgId)
            throw new shared_1.ValidationError("x-organization-id header is required");
        // Auth Check
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId: orgId, userId: req.user.id }
        });
        if (!membership)
            throw new shared_1.ForbiddenError();
        const incidents = await database_1.prisma.incident.findMany({
            orderBy: { firstDetectedAt: "desc" }
        });
        res.status(200).json(incidents);
    }
    catch (err) {
        next(err);
    }
});
// GET /api/incidents/:id
router.get("/:id", async (req, res, next) => {
    try {
        const orgId = req.organizationId;
        if (!orgId)
            throw new shared_1.ValidationError("x-organization-id header is required");
        // Auth Check
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId: orgId, userId: req.user.id }
        });
        if (!membership)
            throw new shared_1.ForbiddenError();
        const incident = await database_1.prisma.incident.findUnique({
            where: { id: req.params.id }
        });
        if (!incident) {
            return res.status(404).json({ error: "NOT_FOUND", message: "Incident not found" });
        }
        res.status(200).json(incident);
    }
    catch (err) {
        next(err);
    }
});
// GET /api/incidents/:id/timeline
router.get("/:id/timeline", async (req, res, next) => {
    try {
        const orgId = req.organizationId;
        if (!orgId)
            throw new shared_1.ValidationError("x-organization-id header is required");
        // Auth Check
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId: orgId, userId: req.user.id }
        });
        if (!membership)
            throw new shared_1.ForbiddenError();
        const events = await database_1.prisma.incidentEvent.findMany({
            where: { incidentId: req.params.id },
            orderBy: { timestamp: "asc" }
        });
        res.status(200).json(events);
    }
    catch (err) {
        next(err);
    }
});
// POST /api/incidents/:id/comments
router.post("/:id/comments", async (req, res, next) => {
    try {
        const orgId = req.organizationId;
        if (!orgId)
            throw new shared_1.ValidationError("x-organization-id header is required");
        const { comment } = req.body;
        if (!comment)
            throw new shared_1.ValidationError("comment field is required");
        // Auth Check
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId: orgId, userId: req.user.id }
        });
        if (!membership)
            throw new shared_1.ForbiddenError();
        const event = await database_1.prisma.incidentEvent.create({
            data: {
                incidentId: req.params.id,
                type: "COMMENT",
                message: comment
            }
        });
        res.status(201).json(event);
    }
    catch (err) {
        next(err);
    }
});
// POST /api/incidents/:id/investigate
router.post("/:id/investigate", async (req, res, next) => {
    try {
        const orgId = req.organizationId;
        if (!orgId)
            throw new shared_1.ValidationError("x-organization-id header is required");
        // Auth Check
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId: orgId, userId: req.user.id }
        });
        if (!membership)
            throw new shared_1.ForbiddenError();
        const incident = await database_1.prisma.incident.findUnique({
            where: { id: req.params.id }
        });
        if (!incident) {
            return res.status(404).json({ error: "NOT_FOUND", message: "Incident not found" });
        }
        // Update incident status
        const updatedIncident = await database_1.prisma.incident.update({
            where: { id: req.params.id },
            data: { status: "INVESTIGATING" }
        });
        // Log action to timeline
        await database_1.prisma.incidentEvent.create({
            data: {
                incidentId: req.params.id,
                type: "AGENT_TRIGGERED",
                message: `OpsPilot agent investigation manually triggered by user ${req.user.email}`
            }
        });
        res.status(200).json({ status: "success", incident: updatedIncident });
    }
    catch (err) {
        next(err);
    }
});
exports.incidentRouter = router;
//# sourceMappingURL=incidents.js.map