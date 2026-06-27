import { Router, Response, NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { prisma } from "@opspilot/database";
import { GitHubClient } from "@opspilot/connector-github";
import { config, ForbiddenError, ValidationError } from "@opspilot/shared";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

router.post("/webhook", async (_req, res) => {
  res.status(202).json({
    status: "accepted",
    message: "GitHub webhooks are processed by the github-worker webhook receiver."
  });
});

router.use(authMiddleware);

router.get("/install", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const organizationId = await resolveOrganizationId(req, optionalString(req.query.organizationId));
    const appSlug = config.github.appSlug || config.github.clientId;
    if (!appSlug) {
      throw new ValidationError("GITHUB_APP_SLUG is required to generate the GitHub App installation URL");
    }

    const state = Buffer.from(JSON.stringify({
      organizationId,
      userId: req.user!.id,
      nonce: cryptoRandom()
    })).toString("base64url");

    const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
    url.searchParams.set("state", state);

    res.status(200).json({ url: url.toString(), state });
  } catch (err) {
    next(err);
  }
});

router.get("/callback", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const installationId = requiredString(req.query.installation_id, "installation_id");
    const organizationId = await resolveOrganizationId(req, organizationIdFromState(optionalString(req.query.state)));

    const installation = await prisma.gitHubInstallation.upsert({
      where: { installationId },
      update: {
        suspendedAt: null
      },
      create: {
        organizationId,
        installationId,
        accountLogin: optionalString(req.query.account) || "unknown",
        accountType: "unknown",
        permissions: {}
      }
    });

    await prisma.auditLog.create({
      data: {
        orgId: organizationId,
        userId: req.user!.id,
        action: "github.installation.callback",
        payload: {
          installationId,
          setupAction: optionalString(req.query.setup_action),
          installationRecordId: installation.id
        }
      }
    });

    res.status(200).json({ installation });
  } catch (err) {
    next(err);
  }
});

router.get("/installations/:id/repositories", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const installation = await requireOwnedInstallation(req, req.params.id);
    const client = new GitHubClient();
    const token = await client.getInstallationToken(installation.installationId);

    if (token.startsWith("mock_")) {
      const repositories = await prisma.repository.findMany({
        where: { githubInstallationId: installation.id },
        orderBy: { createdAt: "desc" }
      });
      return res.status(200).json({
        installationId: installation.installationId,
        repositories: repositories.map(repo => ({
          id: repo.githubRepositoryId,
          name: repo.name,
          fullName: repo.githubFullName,
          cloneUrl: repo.gitUrl,
          defaultBranch: repo.branch,
          connectedRepositoryId: repo.id
        }))
      });
    }

    const ghRes = await fetch("https://api.github.com/installation/repositories", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "OpsPilot-App"
      }
    });
    if (!ghRes.ok) {
      throw new ValidationError(`GitHub repository listing failed: ${ghRes.status} ${ghRes.statusText}`);
    }

    const body = await ghRes.json() as any;
    res.status(200).json({
      installationId: installation.installationId,
      repositories: (body.repositories || []).map(normalizeGitHubRepository)
    });
  } catch (err) {
    next(err);
  }
});

router.post("/repositories/connect", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const {
      projectId,
      installationId,
      githubRepositoryId,
      name,
      fullName,
      cloneUrl,
      defaultBranch,
      directory
    } = req.body || {};

    if (!projectId || !installationId || !githubRepositoryId || !name) {
      throw new ValidationError("projectId, installationId, githubRepositoryId, and name are required");
    }

    const project = await prisma.project.findUnique({ where: { id: String(projectId) } });
    if (!project) throw new ValidationError("Project not found");
    await requireOrganizationMembership(req, project.organizationId);

    const installation = await prisma.gitHubInstallation.findUnique({
      where: { installationId: String(installationId) }
    });
    if (!installation || installation.organizationId !== project.organizationId || installation.suspendedAt) {
      throw new ForbiddenError("GitHub installation is not available for this organization");
    }

    const gitUrl = cloneUrl || (fullName ? `https://github.com/${fullName}.git` : undefined);
    if (!gitUrl) throw new ValidationError("cloneUrl or fullName is required");

    const repository = await prisma.repository.upsert({
      where: { githubRepositoryId: String(githubRepositoryId) },
      update: {
        projectId: project.id,
        name: String(name),
        gitUrl: String(gitUrl),
        branch: String(defaultBranch || "main"),
        directory: String(directory || "/"),
        githubFullName: fullName ? String(fullName) : null,
        githubInstallationId: installation.id
      },
      create: {
        projectId: project.id,
        name: String(name),
        gitUrl: String(gitUrl),
        branch: String(defaultBranch || "main"),
        directory: String(directory || "/"),
        githubRepositoryId: String(githubRepositoryId),
        githubFullName: fullName ? String(fullName) : null,
        githubInstallationId: installation.id
      }
    });

    await prisma.auditLog.create({
      data: {
        orgId: project.organizationId,
        userId: req.user!.id,
        action: "github.repository.connected",
        payload: {
          repositoryId: repository.id,
          githubRepositoryId: repository.githubRepositoryId,
          installationId: installation.installationId
        }
      }
    });

    res.status(200).json(repository);
  } catch (err) {
    next(err);
  }
});

router.delete("/repositories/:id/disconnect", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const repository = await prisma.repository.findUnique({
      where: { id: req.params.id },
      include: { project: true, githubInstallation: true }
    });
    if (!repository) throw new ValidationError("Repository not found");
    await requireOrganizationMembership(req, repository.project.organizationId);

    const updated = await prisma.repository.update({
      where: { id: repository.id },
      data: { githubInstallationId: null }
    });

    await prisma.auditLog.create({
      data: {
        orgId: repository.project.organizationId,
        userId: req.user!.id,
        action: "github.repository.disconnected",
        payload: {
          repositoryId: repository.id,
          installationId: repository.githubInstallation?.installationId
        }
      }
    });

    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
});

async function requireOwnedInstallation(req: AuthenticatedRequest, installationId: string) {
  const installation = await prisma.gitHubInstallation.findUnique({
    where: { installationId }
  });
  if (!installation) throw new ValidationError("GitHub installation not found");
  await requireOrganizationMembership(req, installation.organizationId);
  return installation;
}

async function requireOrganizationMembership(req: AuthenticatedRequest, organizationId: string): Promise<void> {
  const membership = await prisma.membership.findFirst({
    where: {
      organizationId,
      userId: req.user!.id
    }
  });
  if (!membership) throw new ForbiddenError("You do not have access to this organization");
}

async function resolveOrganizationId(req: AuthenticatedRequest, requestedOrganizationId?: string): Promise<string> {
  if (requestedOrganizationId) {
    await requireOrganizationMembership(req, requestedOrganizationId);
    return requestedOrganizationId;
  }

  const membership = await prisma.membership.findFirst({
    where: { userId: req.user!.id },
    orderBy: { createdAt: "asc" }
  });
  if (!membership) {
    throw new ValidationError("User is not a member of any organization");
  }
  return membership.organizationId;
}

function organizationIdFromState(state?: string): string | undefined {
  if (!state) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    return typeof parsed.organizationId === "string" ? parsed.organizationId : undefined;
  } catch {
    return undefined;
  }
}

function normalizeGitHubRepository(repo: any) {
  return {
    id: String(repo.id),
    name: repo.name,
    fullName: repo.full_name,
    cloneUrl: repo.clone_url,
    sshUrl: repo.ssh_url,
    private: Boolean(repo.private),
    defaultBranch: repo.default_branch
  };
}

function requiredString(value: unknown, name: string): string {
  const parsed = optionalString(value);
  if (!parsed) throw new ValidationError(`${name} is required`);
  return parsed;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function cryptoRandom(): string {
  return randomUUID();
}

export const githubRouter: Router = router;
