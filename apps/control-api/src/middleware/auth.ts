import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config, logger, TenantContextHolder, UnauthorizedError } from "@opspilot/shared";
import { prisma } from "@opspilot/database";

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
  };
  organizationId?: string;
  projectId?: string;
}

export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next(new UnauthorizedError("No token provided"));
  }

  const token = authHeader.replace("Bearer ", "");

  try {
    const decoded = jwt.verify(token, config.jwtSecret) as { userId: string; email: string };
    
    // Fetch user from DB to verify active account
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });

    if (!user) {
      return next(new UnauthorizedError("User no longer exists"));
    }

    (req as AuthenticatedRequest).user = {
      id: user.id,
      email: user.email
    };

    // Extract scoped workspace elements
    const organizationId = (req.headers["x-organization-id"] as string) || "";
    const projectId = (req.headers["x-project-id"] as string) || "";

    if (organizationId) {
      (req as AuthenticatedRequest).organizationId = organizationId;
    }
    if (projectId) {
      (req as AuthenticatedRequest).projectId = projectId;
    }

    // Set Tenant context for downstream async tasks
    TenantContextHolder.run(
      {
        organizationId,
        projectId,
        userId: user.id,
        correlationId: (req.headers["x-correlation-id"] as string) || ""
      },
      () => {
        next();
      }
    );
  } catch (err: any) {
    logger.error({ err }, "JWT verification failure");
    return next(new UnauthorizedError("Invalid or expired session token"));
  }
}
