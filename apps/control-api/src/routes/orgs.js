"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.orgRouter = void 0;
const express_1 = require("express");
const database_1 = require("@opspilot/database");
const shared_1 = require("@opspilot/shared");
const auth_js_1 = require("../middleware/auth.js");
const router = (0, express_1.Router)();
router.use(auth_js_1.authMiddleware);
// POST /api/organizations
router.post("/", async (req, res, next) => {
    try {
        const { name } = req.body;
        if (!name)
            throw new shared_1.ValidationError("Organization name is required");
        const org = await database_1.prisma.organization.create({
            data: { name }
        });
        // Fetch or create Admin role
        let adminRole = await database_1.prisma.role.findUnique({ where: { name: "ADMIN" } });
        if (!adminRole) {
            adminRole = await database_1.prisma.role.create({
                data: { id: "role_admin", name: "ADMIN", description: "Admin access" }
            });
        }
        // Set membership
        await database_1.prisma.membership.create({
            data: {
                organizationId: org.id,
                userId: req.user.id,
                roleId: adminRole.id
            }
        });
        // Create audit log
        await database_1.prisma.auditLog.create({
            data: {
                orgId: org.id,
                userId: req.user.id,
                action: "org.create",
                payload: { orgName: org.name }
            }
        });
        res.status(201).json(org);
    }
    catch (err) {
        next(err);
    }
});
// GET /api/organizations
router.get("/", async (req, res, next) => {
    try {
        const memberships = await database_1.prisma.membership.findMany({
            where: { userId: req.user.id },
            include: { organization: true }
        });
        res.status(200).json(memberships.map(m => m.organization));
    }
    catch (err) {
        next(err);
    }
});
// GET /api/organizations/:id/members
router.get("/:id/members", async (req, res, next) => {
    try {
        const { id } = req.params;
        // Auth Check
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId: id, userId: req.user.id }
        });
        if (!membership)
            throw new shared_1.ForbiddenError();
        const members = await database_1.prisma.membership.findMany({
            where: { organizationId: id },
            include: {
                user: { select: { id: true, email: true } },
                role: true
            }
        });
        res.status(200).json(members.map(m => ({
            userId: m.userId,
            email: m.user.email,
            role: m.role.name
        })));
    }
    catch (err) {
        next(err);
    }
});
// POST /api/organizations/:id/invitations
router.post("/:id/invitations", async (req, res, next) => {
    try {
        const { id } = req.params;
        const { email, role } = req.body;
        if (!email || !role)
            throw new shared_1.ValidationError("email and role are required");
        // Auth Check: Must be admin
        const membership = await database_1.prisma.membership.findFirst({
            where: { organizationId: id, userId: req.user.id },
            include: { role: true }
        });
        if (!membership || membership.role.name !== "ADMIN") {
            throw new shared_1.ForbiddenError("Only organization admins can invite members");
        }
        // Trigger Notification Event
        await database_1.prisma.notification.create({
            data: {
                orgId: id,
                channel: "email",
                target: email,
                message: `You have been invited to join the organization on role ${role}.`,
                sent: false
            }
        });
        // Audit log
        await database_1.prisma.auditLog.create({
            data: {
                orgId: id,
                userId: req.user.id,
                action: "org.member.invite",
                payload: { invitedEmail: email, role }
            }
        });
        res.status(201).json({ status: "invited", email });
    }
    catch (err) {
        next(err);
    }
});
exports.orgRouter = router;
//# sourceMappingURL=orgs.js.map