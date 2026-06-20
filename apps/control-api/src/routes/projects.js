"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.projectRouter = void 0;
const express_1 = require("express");
const database_1 = require("@opspilot/database");
const shared_1 = require("@opspilot/shared");
const auth_js_1 = require("../middleware/auth.js");
const router = (0, express_1.Router)();
router.use(auth_js_1.authMiddleware);
// POST /api/projects
router.post("/", async (req, res, next) => {
    try {
        const { name } = req.body;
        const organizationId = req.organizationId || req.body.organizationId;
        if (!name)
            throw new shared_1.ValidationError("Project name is required");
        if (!organizationId)
            throw new shared_1.ValidationError("OrganizationId is required");
        // Auth Check
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId, userId: req.user.id }
        });
        if (!membership)
            throw new shared_1.ForbiddenError();
        const project = await database_1.prisma.project.create({
            data: {
                name,
                organizationId
            }
        });
        // Audit log
        await database_1.prisma.auditLog.create({
            data: {
                orgId: organizationId,
                userId: req.user.id,
                action: "project.create",
                payload: { projectId: project.id, projectName: project.name }
            }
        });
        res.status(201).json(project);
    }
    catch (err) {
        next(err);
    }
});
// GET /api/projects
router.get("/", async (req, res, next) => {
    try {
        const organizationId = req.organizationId;
        if (!organizationId) {
            throw new shared_1.ValidationError("x-organization-id header is required to retrieve projects");
        }
        // Auth Check
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId, userId: req.user.id }
        });
        if (!membership)
            throw new shared_1.ForbiddenError();
        const projects = await database_1.prisma.project.findMany({
            where: { organizationId },
            include: { repositories: true }
        });
        res.status(200).json(projects);
    }
    catch (err) {
        next(err);
    }
});
exports.projectRouter = router;
//# sourceMappingURL=projects.js.map