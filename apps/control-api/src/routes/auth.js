"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authRouter = void 0;
const express_1 = require("express");
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const database_1 = require("@opspilot/database");
const shared_1 = require("@opspilot/shared");
const auth_js_1 = require("../middleware/auth.js");
const router = (0, express_1.Router)();
// POST /api/auth/register
router.post("/register", async (req, res, next) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            throw new shared_1.ValidationError("Email and password are required");
        }
        // Check if user exists
        const existing = await database_1.prisma.user.findUnique({ where: { email } });
        if (existing) {
            throw new shared_1.ValidationError("User already exists");
        }
        const passwordHash = await bcrypt_1.default.hash(password, 10);
        const user = await database_1.prisma.user.create({
            data: {
                email,
                passwordHash,
                verified: false
            }
        });
        // Audit Log
        await database_1.prisma.auditLog.create({
            data: {
                orgId: "system",
                userId: user.id,
                action: "user.register",
                payload: { email: user.email }
            }
        });
        res.status(201).json({ id: user.id, email: user.email, verified: user.verified });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/auth/login
router.post("/login", async (req, res, next) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            throw new shared_1.ValidationError("Email and password are required");
        }
        const user = await database_1.prisma.user.findUnique({ where: { email } });
        if (!user || !(await bcrypt_1.default.compare(password, user.passwordHash))) {
            throw new shared_1.UnauthorizedError("Invalid email or password");
        }
        // Sign JWT token
        const token = jsonwebtoken_1.default.sign({ userId: user.id, email: user.email }, shared_1.config.jwtSecret, {
            expiresIn: "24h"
        });
        // Save session in DB
        const sessionToken = (0, shared_1.generateId)("sess");
        await database_1.prisma.session.create({
            data: {
                userId: user.id,
                token: sessionToken,
                ipAddress: req.ip,
                userAgent: req.headers["user-agent"],
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
            }
        });
        res.status(200).json({ token, user: { id: user.id, email: user.email } });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/auth/logout
router.post("/logout", auth_js_1.authMiddleware, async (req, res, next) => {
    try {
        const authedReq = req;
        if (authedReq.user) {
            await database_1.prisma.session.deleteMany({
                where: { userId: authedReq.user.id }
            });
        }
        res.status(200).json({ status: "logged_out" });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/auth/verify-email
router.post("/verify-email", async (req, res, next) => {
    try {
        const { userId } = req.body;
        if (!userId)
            throw new shared_1.ValidationError("userId is required");
        await database_1.prisma.user.update({
            where: { id: userId },
            data: { verified: true }
        });
        res.status(200).json({ status: "verified" });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/auth/reset-password
router.post("/reset-password", async (req, res, next) => {
    try {
        const { email, newPassword } = req.body;
        if (!email || !newPassword)
            throw new shared_1.ValidationError("email and newPassword are required");
        const user = await database_1.prisma.user.findUnique({ where: { email } });
        if (!user)
            throw new shared_1.ValidationError("User not found");
        const passwordHash = await bcrypt_1.default.hash(newPassword, 10);
        await database_1.prisma.user.update({
            where: { id: user.id },
            data: { passwordHash }
        });
        res.status(200).json({ status: "password_reset_success" });
    }
    catch (err) {
        next(err);
    }
});
// POST /api/auth/2fa
router.post("/2fa", async (req, res, next) => {
    try {
        const { code } = req.body;
        if (code === "123456") {
            res.status(200).json({ status: "2fa_success" });
        }
        else {
            throw new shared_1.UnauthorizedError("Invalid 2FA code");
        }
    }
    catch (err) {
        next(err);
    }
});
// GET /api/auth/sessions
router.get("/sessions", auth_js_1.authMiddleware, async (req, res, next) => {
    try {
        const authedReq = req;
        const dbSessions = await database_1.prisma.session.findMany({
            where: { userId: authedReq.user.id }
        });
        res.status(200).json(dbSessions);
    }
    catch (err) {
        next(err);
    }
});
exports.authRouter = router;
//# sourceMappingURL=auth.js.map