"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.billingRouter = void 0;
const express_1 = require("express");
const database_1 = require("@opspilot/database");
const shared_1 = require("@opspilot/shared");
const auth_js_1 = require("../middleware/auth.js");
const router = (0, express_1.Router)();
router.use(auth_js_1.authMiddleware);
// GET /api/usage
router.get("/usage", async (req, res, next) => {
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
        const records = await database_1.prisma.usageRecord.findMany({
            where: { orgId }
        });
        res.status(200).json(records);
    }
    catch (err) {
        next(err);
    }
});
// GET /api/billing
router.get("/billing", async (req, res, next) => {
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
        const subscription = await database_1.prisma.subscription.findUnique({
            where: { orgId }
        });
        res.status(200).json(subscription || { orgId, planId: "free", status: "active" });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/subscriptions
router.post("/subscriptions", async (req, res, next) => {
    try {
        const orgId = req.organizationId;
        const { planId } = req.body;
        if (!orgId)
            throw new shared_1.ValidationError("x-organization-id header is required");
        if (!planId)
            throw new shared_1.ValidationError("planId is required");
        // Auth Check: Admin only
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId: orgId, userId: req.user.id },
            include: { role: true }
        });
        if (!membership || membership.role.name !== "ADMIN") {
            throw new shared_1.ForbiddenError("Only organization admins can upgrade subscriptions");
        }
        const subscription = await database_1.prisma.subscription.upsert({
            where: { orgId },
            update: { planId, status: "active" },
            create: { orgId, planId, status: "active" }
        });
        // Audit log
        await database_1.prisma.auditLog.create({
            data: {
                orgId,
                userId: req.user.id,
                action: "org.subscription.upgrade",
                payload: { planId }
            }
        });
        res.status(200).json(subscription);
    }
    catch (err) {
        next(err);
    }
});
exports.billingRouter = router;
//# sourceMappingURL=billing.js.map