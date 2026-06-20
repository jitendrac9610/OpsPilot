"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditRouter = void 0;
const express_1 = require("express");
const database_1 = require("@opspilot/database");
const shared_1 = require("@opspilot/shared");
const auth_js_1 = require("../middleware/auth.js");
const router = (0, express_1.Router)();
router.use(auth_js_1.authMiddleware);
// GET /api/audit-logs
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
        const logs = await database_1.prisma.auditLog.findMany({
            where: { orgId },
            orderBy: { timestamp: "desc" }
        });
        res.status(200).json(logs);
    }
    catch (err) {
        next(err);
    }
});
exports.auditRouter = router;
//# sourceMappingURL=audit.js.map