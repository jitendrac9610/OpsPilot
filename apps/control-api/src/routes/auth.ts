import { Router, Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { prisma } from "@opspilot/database";
import { config, ValidationError, UnauthorizedError, generateId } from "@opspilot/shared";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

// POST /api/auth/register
router.post("/register", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      throw new ValidationError("Email and password are required");
    }

    // Check if user exists
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      throw new ValidationError("User already exists");
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        verified: false
      }
    });

    // Audit Log
    await prisma.auditLog.create({
      data: {
        orgId: "system",
        userId: user.id,
        action: "user.register",
        payload: { email: user.email }
      }
    });

    res.status(201).json({ id: user.id, email: user.email, verified: user.verified });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post("/login", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      throw new ValidationError("Email and password are required");
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedError("Invalid email or password");
    }

    // Sign JWT token
    const token = jwt.sign({ userId: user.id, email: user.email }, config.jwtSecret, {
      expiresIn: "24h"
    });

    // Save session in DB
    const sessionToken = generateId("sess");
    await prisma.session.create({
      data: {
        userId: user.id,
        token: sessionToken,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    });

    res.status(200).json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
router.post("/logout", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authedReq = req as AuthenticatedRequest;
    if (authedReq.user) {
      await prisma.session.deleteMany({
        where: { userId: authedReq.user.id }
      });
    }
    res.status(200).json({ status: "logged_out" });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/verify-email
router.post("/verify-email", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId } = req.body;
    if (!userId) throw new ValidationError("userId is required");

    await prisma.user.update({
      where: { id: userId },
      data: { verified: true }
    });

    res.status(200).json({ status: "verified" });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/reset-password
router.post("/reset-password", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, newPassword } = req.body;
    if (!email || !newPassword) throw new ValidationError("email and newPassword are required");

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new ValidationError("User not found");

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash }
    });

    res.status(200).json({ status: "password_reset_success" });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/2fa
router.post("/2fa", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.body;
    if (code === "123456") {
      res.status(200).json({ status: "2fa_success" });
    } else {
      throw new UnauthorizedError("Invalid 2FA code");
    }
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/sessions
router.get("/sessions", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authedReq = req as AuthenticatedRequest;
    const dbSessions = await prisma.session.findMany({
      where: { userId: authedReq.user!.id }
    });
    res.status(200).json(dbSessions);
  } catch (err) {
    next(err);
  }
});

export const authRouter: Router = router;
