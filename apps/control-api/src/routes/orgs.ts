import { Router, Response, NextFunction } from "express";
import { prisma } from "@opspilot/database";
import { ValidationError, ForbiddenError } from "@opspilot/shared";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

router.use(authMiddleware);

// POST /api/organizations
router.post("/", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { name } = req.body;
    if (!name) throw new ValidationError("Organization name is required");

    const org = await prisma.organization.create({
      data: { name }
    });

    // Fetch or create Admin role
    let adminRole = await prisma.role.findUnique({ where: { name: "ADMIN" } });
    if (!adminRole) {
      adminRole = await prisma.role.create({
        data: { id: "role_admin", name: "ADMIN", description: "Admin access" }
      });
    }

    // Set membership
    await prisma.membership.create({
      data: {
        organizationId: org.id,
        userId: req.user!.id,
        roleId: adminRole.id
      }
    });

    // Create audit log
    await prisma.auditLog.create({
      data: {
        orgId: org.id,
        userId: req.user!.id,
        action: "org.create",
        payload: { orgName: org.name }
      }
    });

    res.status(201).json(org);
  } catch (err) {
    next(err);
  }
});

// GET /api/organizations
router.get("/", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const memberships = await prisma.membership.findMany({
      where: { userId: req.user!.id },
      include: { organization: true }
    });
    res.status(200).json(memberships.map(m => m.organization));
  } catch (err) {
    next(err);
  }
});

// GET /api/organizations/:id/members
router.get("/:id/members", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    
    // Auth Check
    const membership = await prisma.membership.findFirst({
      where: { organizationId: id, userId: req.user!.id }
    });
    if (!membership) throw new ForbiddenError();

    const members = await prisma.membership.findMany({
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
  } catch (err) {
    next(err);
  }
});

// POST /api/organizations/:id/invitations
router.post("/:id/invitations", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const { email, role } = req.body;
    if (!email || !role) throw new ValidationError("email and role are required");

    // Auth Check: Must be admin
    const membership = await prisma.membership.findFirst({
      where: { organizationId: id, userId: req.user!.id },
      include: { role: true }
    });
    if (!membership || membership.role.name !== "ADMIN") {
      throw new ForbiddenError("Only organization admins can invite members");
    }

    // Trigger Notification Event
    await prisma.notification.create({
      data: {
        orgId: id,
        channel: "email",
        target: email,
        message: `You have been invited to join the organization on role ${role}.`,
        sent: false
      }
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        orgId: id,
        userId: req.user!.id,
        action: "org.member.invite",
        payload: { invitedEmail: email, role }
      }
    });

    res.status(201).json({ status: "invited", email });
  } catch (err) {
    next(err);
  }
});

export const orgRouter: Router = router;
