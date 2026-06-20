import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import {
  config,
  ForbiddenError,
  logger,
  OpsPilotError,
  TenantContextHolder,
  UnauthorizedError
} from "@opspilot/shared";
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

    // Resolve and verify scoped workspace elements before trusting them.
    let organizationId = (req.headers["x-organization-id"] as string) || "";
    const projectId = (req.headers["x-project-id"] as string) || "";

    if (projectId) {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { organizationId: true }
      });
      if (!project || (organizationId && project.organizationId !== organizationId)) {
        return next(new ForbiddenError("Project is not accessible in the requested organization"));
      }
      organizationId = project.organizationId;
    }

    if (organizationId) {
      const membership = await prisma.membership.findFirst({
        where: { organizationId, userId: user.id },
        select: { id: true }
      });
      if (!membership) {
        return next(new ForbiddenError("Active organization membership is required"));
      }
    }

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
    if (err instanceof OpsPilotError) return next(err);
    logger.error({ err }, "JWT verification failure");
    return next(new UnauthorizedError("Invalid or expired session token"));
  }
}
