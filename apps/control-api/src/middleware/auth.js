"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = authMiddleware;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const shared_1 = require("@opspilot/shared");
const database_1 = require("@opspilot/database");
async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return next(new shared_1.UnauthorizedError("No token provided"));
    }
    const token = authHeader.replace("Bearer ", "");
    try {
        const decoded = jsonwebtoken_1.default.verify(token, shared_1.config.jwtSecret);
        // Fetch user from DB to verify active account
        const user = await database_1.prisma.user.findUnique({
            where: { id: decoded.userId }
        });
        if (!user) {
            return next(new shared_1.UnauthorizedError("User no longer exists"));
        }
        req.user = {
            id: user.id,
            email: user.email
        };
        // Extract scoped workspace elements
        const organizationId = req.headers["x-organization-id"] || "";
        const projectId = req.headers["x-project-id"] || "";
        if (organizationId) {
            req.organizationId = organizationId;
        }
        if (projectId) {
            req.projectId = projectId;
        }
        // Set Tenant context for downstream async tasks
        shared_1.TenantContextHolder.run({
            organizationId,
            projectId,
            userId: user.id,
            correlationId: req.headers["x-correlation-id"] || ""
        }, () => {
            next();
        });
    }
    catch (err) {
        shared_1.logger.error({ err }, "JWT verification failure");
        return next(new shared_1.UnauthorizedError("Invalid or expired session token"));
    }
}
//# sourceMappingURL=auth.js.map