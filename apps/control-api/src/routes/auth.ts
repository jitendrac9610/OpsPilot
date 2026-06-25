import { Router, Request, Response, NextFunction } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import Redis from "ioredis";
import { prisma } from "@opspilot/database";
import { config, ValidationError, UnauthorizedError, generateId, logger } from "@opspilot/shared";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth.js";
import { generateBase32Secret, verifyTOTP } from "../utils/totp.js";

const router = Router();
const redis = new Redis(config.redisUrl);

// Generic rate limiter middleware using Redis
function rateLimiter(limit: number, windowSec: number, actionName: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (process.env.NODE_ENV === "test") {
      return next();
    }
    const identifier = req.body?.email || req.ip || "unknown";
    const key = `rate-limit:${identifier}:${actionName}`;
    try {
      const current = await redis.incr(key);
      if (current === 1) {
        await redis.expire(key, windowSec);
      }
      if (current > limit) {
        return res.status(429).json({
          error: "TOO_MANY_REQUESTS",
          message: `Too many attempts for ${actionName}. Please try again in a few minutes.`
        });
      }
      next();
    } catch (err) {
      logger.error({ err, key }, "Rate limiter Redis failure");
      next(); // Fail open to avoid blocking users
    }
  };
}

// POST /api/auth/register
router.post("/register", rateLimiter(5, 900, "register"), async (req: Request, res: Response, next: NextFunction) => {
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

    // Generate expiring email verification token
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(verificationToken).digest("hex");
    await redis.set(`verify-email:${tokenHash}`, user.id, "EX", 24 * 60 * 60); // Expire in 24h

    // Audit Log
    await prisma.auditLog.create({
      data: {
        orgId: "system",
        userId: user.id,
        action: "user.register",
        payload: { email: user.email, ipAddress: req.ip, userAgent: req.headers["user-agent"] }
      }
    });

    // generic responses: hide verificationToken in production environments
    const isProduction = process.env.NODE_ENV === "production" || config.opspilotMode === "production";
    res.status(201).json({
      id: user.id,
      email: user.email,
      verified: user.verified,
      ...(!isProduction ? { verificationToken } : {})
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post("/login", rateLimiter(5, 900, "login"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      throw new ValidationError("Email and password are required");
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      // Audit log failed login
      await prisma.auditLog.create({
        data: {
          orgId: "system",
          action: "user.login-failed",
          payload: { email, ipAddress: req.ip, userAgent: req.headers["user-agent"] }
        }
      });
      throw new UnauthorizedError("Invalid email or password");
    }

    // Check if 2FA is enabled
    const twoFactorEnabled = await redis.get(`2fa:enabled:${user.id}`) === "true";
    if (twoFactorEnabled) {
      return res.status(200).json({
        status: "2fa_required",
        userId: user.id,
        message: "Two-factor authentication code is required to complete login."
      });
    }

    // Session rotation: invalidate previous sessions
    await prisma.session.deleteMany({
      where: { userId: user.id }
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

    // Sign JWT token containing sessionId (expiry 15m)
    const token = jwt.sign({ userId: user.id, email: user.email, sessionId: sessionToken }, config.jwtSecret, {
      expiresIn: "15m"
    });

    // Generate refresh token (7 days expiry)
    const refreshToken = crypto.randomBytes(40).toString("hex");
    const refreshTokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
    await redis.set(`refresh-token:${refreshTokenHash}`, user.id, "EX", 7 * 24 * 60 * 60);
    await redis.sadd(`user-refresh-tokens:${user.id}`, refreshTokenHash);

    // Audit Log
    await prisma.auditLog.create({
      data: {
        orgId: "system",
        userId: user.id,
        action: "user.login-success",
        payload: { ipAddress: req.ip, userAgent: req.headers["user-agent"] }
      }
    });

    // Set refresh token in secure HTTP-only cookie
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production" || config.opspilotMode === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.status(200).json({
      token,
      refreshToken, // Expose in body for compatibility and testing
      user: { id: user.id, email: user.email }
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/logout
router.post("/logout", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authedReq = req as AuthenticatedRequest;
    if (authedReq.user) {
      const userId = authedReq.user.id;
      // Invalidate database sessions
      await prisma.session.deleteMany({
        where: { userId }
      });

      // Invalidate refresh tokens
      const tokenHashes = await redis.smembers(`user-refresh-tokens:${userId}`);
      for (const h of tokenHashes) {
        await redis.del(`refresh-token:${h}`);
      }
      await redis.del(`user-refresh-tokens:${userId}`);

      // Audit Log
      await prisma.auditLog.create({
        data: {
          orgId: "system",
          userId,
          action: "user.logout",
          payload: { ipAddress: req.ip, userAgent: req.headers["user-agent"] }
        }
      });
    }

    res.clearCookie("refreshToken");
    res.status(200).json({ status: "logged_out" });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/verify-email
router.post("/verify-email", rateLimiter(10, 900, "verify-email"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.body;
    if (!token) throw new ValidationError("token is required");

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const userId = await redis.get(`verify-email:${tokenHash}`);
    
    if (!userId) {
      throw new ValidationError("Verification token is invalid or has expired");
    }

    await prisma.user.update({
      where: { id: userId },
      data: { verified: true }
    });

    // Invalidate token
    await redis.del(`verify-email:${tokenHash}`);

    // Audit Log
    await prisma.auditLog.create({
      data: {
        orgId: "system",
        userId,
        action: "user.email-verified",
        payload: { ipAddress: req.ip, userAgent: req.headers["user-agent"] }
      }
    });

    res.status(200).json({ status: "verified" });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/forgot-password (request link)
router.post("/forgot-password", rateLimiter(3, 900, "forgot-password"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body;
    if (!email) throw new ValidationError("email is required");

    const user = await prisma.user.findUnique({ where: { email } });
    
    // Always respond with a generic success response to avoid account enumeration
    const isProduction = process.env.NODE_ENV === "production" || config.opspilotMode === "production";
    const respondSuccess = (token?: string) => res.status(200).json({
      status: "success",
      message: "If the email is registered, a password reset token has been generated.",
      ...((token && !isProduction) ? { resetToken: token } : {})
    });

    if (!user) {
      return respondSuccess();
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
    await redis.set(`reset-password:${tokenHash}`, user.id, "EX", 60 * 60); // 1h expiration

    await prisma.auditLog.create({
      data: {
        orgId: "system",
        userId: user.id,
        action: "user.password-reset-requested",
        payload: { email: user.email, ipAddress: req.ip, userAgent: req.headers["user-agent"] }
      }
    });

    // Expose resetToken only in non-production/test environments
    return respondSuccess(resetToken);
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/reset-password (confirm change)
router.post("/reset-password", rateLimiter(5, 900, "reset-password"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword) throw new ValidationError("token and newPassword are required");

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const userId = await redis.get(`reset-password:${tokenHash}`);
    
    if (!userId) {
      throw new ValidationError("Password reset token is invalid or has expired");
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash }
    });

    // Revoke all existing sessions for this user (session revocation)
    await prisma.session.deleteMany({
      where: { userId }
    });

    // Invalidate the reset token after successful use
    await redis.del(`reset-password:${tokenHash}`);

    // Audit Log
    await prisma.auditLog.create({
      data: {
        orgId: "system",
        userId,
        action: "user.password-reset-completed",
        payload: { ipAddress: req.ip, userAgent: req.headers["user-agent"] }
      }
    });

    res.status(200).json({ status: "password_reset_success" });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/refresh
router.post("/refresh", rateLimiter(10, 900, "refresh"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refreshToken = req.body?.refreshToken || req.cookies?.refreshToken;
    if (!refreshToken) {
      throw new ValidationError("Refresh token is required");
    }

    const oldTokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
    const userId = await redis.get(`refresh-token:${oldTokenHash}`);

    // Refresh token reuse detection (token theft defense)
    const isReused = await redis.sismember("used-refresh-tokens", oldTokenHash);
    if (isReused) {
      logger.warn({ oldTokenHash }, "Refresh token reuse detected! Revoking all user tokens and sessions.");
      
      const hijackedUserId = await redis.get(`used-refresh-token-owner:${oldTokenHash}`);
      if (hijackedUserId) {
        // Delete all active refresh tokens for the hijacked user
        const tokenHashes = await redis.smembers(`user-refresh-tokens:${hijackedUserId}`);
        for (const h of tokenHashes) {
          await redis.del(`refresh-token:${h}`);
        }
        await redis.del(`user-refresh-tokens:${hijackedUserId}`);

        // Revoke all database sessions for the hijacked user
        await prisma.session.deleteMany({
          where: { userId: hijackedUserId }
        });

        // Audit Log
        await prisma.auditLog.create({
          data: {
            orgId: "system",
            userId: hijackedUserId,
            action: "user.refresh-token-reuse-attack",
            payload: { ipAddress: req.ip, userAgent: req.headers["user-agent"] }
          }
        });
      }
      
      res.clearCookie("refreshToken");
      throw new UnauthorizedError("Security Alert: Token reuse detected. Please log in again.");
    }

    if (!userId) {
      throw new UnauthorizedError("Invalid or expired refresh token");
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedError("User no longer exists");
    }

    // Invalidate current DB sessions to execute rotation
    await prisma.session.deleteMany({
      where: { userId: user.id }
    });

    const newSessionToken = generateId("sess");
    await prisma.session.create({
      data: {
        userId: user.id,
        token: newSessionToken,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"],
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
      }
    });

    // Generate new short-lived access token
    const newAccessToken = jwt.sign({ userId: user.id, email: user.email, sessionId: newSessionToken }, config.jwtSecret, {
      expiresIn: "15m"
    });

    // Generate new rotated refresh token
    const newRefreshToken = crypto.randomBytes(40).toString("hex");
    const newHash = crypto.createHash("sha256").update(newRefreshToken).digest("hex");

    // Remove old refresh token and track it as used for reuse detection (expire in 1h)
    await redis.del(`refresh-token:${oldTokenHash}`);
    await redis.srem(`user-refresh-tokens:${user.id}`, oldTokenHash);
    
    await redis.set(`used-refresh-token-owner:${oldTokenHash}`, user.id, "EX", 60 * 60);
    await redis.sadd("used-refresh-tokens", oldTokenHash);
    await redis.expire("used-refresh-tokens", 60 * 60);

    // Save new refresh token in Redis
    await redis.set(`refresh-token:${newHash}`, user.id, "EX", 7 * 24 * 60 * 60);
    await redis.sadd(`user-refresh-tokens:${user.id}`, newHash);

    // Set cookie
    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production" || config.opspilotMode === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.status(200).json({
      token: newAccessToken,
      refreshToken: newRefreshToken,
      user: { id: user.id, email: user.email }
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/2fa/setup (generate secret)
router.post("/2fa/setup", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authedReq = req as AuthenticatedRequest;
    const userId = authedReq.user!.id;
    const secret = generateBase32Secret();

    // Store temporary secret for setup verification (15 min)
    await redis.set(`2fa:temp-secret:${userId}`, secret, "EX", 15 * 60);

    res.status(200).json({
      secret,
      qrCodeUrl: `otpauth://totp/OpsPilot:${authedReq.user!.email}?secret=${secret}&issuer=OpsPilot`
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/2fa/enable (verify and save TOTP configuration)
router.post("/2fa/enable", authMiddleware, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authedReq = req as AuthenticatedRequest;
    const userId = authedReq.user!.id;
    const { code } = req.body;
    if (!code) throw new ValidationError("code is required");

    const tempSecret = await redis.get(`2fa:temp-secret:${userId}`);
    if (!tempSecret) throw new ValidationError("2FA setup session expired or not initialized");

    const verified = verifyTOTP(tempSecret, code);
    if (!verified) throw new ValidationError("Invalid 2FA code");

    // Persist permanently
    await redis.set(`2fa:secret:${userId}`, tempSecret);
    await redis.set(`2fa:enabled:${userId}`, "true");
    await redis.del(`2fa:temp-secret:${userId}`);

    // Generate 5 recovery codes
    const recoveryCodes = Array.from({ length: 5 }, () => crypto.randomBytes(4).toString("hex"));
    const hashedCodes = await Promise.all(recoveryCodes.map(c => bcrypt.hash(c, 10)));
    await redis.set(`2fa:recovery-codes:${userId}`, JSON.stringify(hashedCodes));

    await prisma.auditLog.create({
      data: {
        orgId: "system",
        userId,
        action: "user.2fa-enabled",
        payload: { ipAddress: req.ip, userAgent: req.headers["user-agent"] }
      }
    });

    res.status(200).json({ status: "enabled", recoveryCodes });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/2fa (verify TOTP token during login)
router.post("/2fa", rateLimiter(5, 900, "2fa"), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { userId, code } = req.body;
    if (!userId || !code) throw new ValidationError("userId and code are required");

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new ValidationError("User not found");

    const secret = await redis.get(`2fa:secret:${userId}`);
    const isEnabled = await redis.get(`2fa:enabled:${userId}`) === "true";
    if (!isEnabled || !secret) {
      throw new ValidationError("2FA is not enabled for this user");
    }

    let verified = verifyTOTP(secret, code);
    if (!verified) {
      // Check if it is a recovery code
      const storedRecovery = await redis.get(`2fa:recovery-codes:${userId}`);
      if (storedRecovery) {
        const recoveryHashes = JSON.parse(storedRecovery) as string[];
        let matchIndex = -1;
        for (let i = 0; i < recoveryHashes.length; i++) {
          if (await bcrypt.compare(code, recoveryHashes[i])) {
            matchIndex = i;
            break;
          }
        }
        if (matchIndex >= 0) {
          verified = true;
          // Invalidate used recovery code
          recoveryHashes.splice(matchIndex, 1);
          await redis.set(`2fa:recovery-codes:${userId}`, JSON.stringify(recoveryHashes));
        }
      }
    }

    if (!verified) {
      // Audit log failed 2FA
      await prisma.auditLog.create({
        data: {
          orgId: "system",
          userId,
          action: "user.2fa-failed",
          payload: { ipAddress: req.ip, userAgent: req.headers["user-agent"] }
        }
      });
      throw new UnauthorizedError("Invalid 2FA code or recovery code");
    }

    // Session rotation: invalidate previous sessions
    await prisma.session.deleteMany({
      where: { userId: user.id }
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

    // Sign JWT token containing sessionId (expiry 15m)
    const token = jwt.sign({ userId: user.id, email: user.email, sessionId: sessionToken }, config.jwtSecret, {
      expiresIn: "15m"
    });

    // Generate refresh token (7 days expiry)
    const refreshToken = crypto.randomBytes(40).toString("hex");
    const refreshTokenHash = crypto.createHash("sha256").update(refreshToken).digest("hex");
    await redis.set(`refresh-token:${refreshTokenHash}`, user.id, "EX", 7 * 24 * 60 * 60);
    await redis.sadd(`user-refresh-tokens:${user.id}`, refreshTokenHash);

    // Audit Log
    await prisma.auditLog.create({
      data: {
        orgId: "system",
        userId: user.id,
        action: "user.2fa-verify-success",
        payload: { ipAddress: req.ip, userAgent: req.headers["user-agent"] }
      }
    });

    // Set cookie
    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production" || config.opspilotMode === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000
    });

    res.status(200).json({
      token,
      refreshToken, // Expose in body for compatibility and testing
      user: { id: user.id, email: user.email }
    });
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
