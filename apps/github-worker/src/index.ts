import express, { Express, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import Redis from "ioredis";
import { logger, config, OpsPilotError } from "@opspilot/shared";
import { prisma } from "@opspilot/database";
import { createCommitSnapshot } from "./archiver.js";

const app: Express = express();

// Parse json and populate req.rawBody with raw buffer for signature verification
app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf;
  }
}));

// Initialize Redis client using config
const redis = new Redis(config.redisUrl);

// Handle redis connection error events to avoid uncaught exceptions
redis.on("error", (err) => {
  logger.error({ err }, "Redis connection error in github-worker");
});

function verifyGithubSignature(req: Request): boolean {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature || typeof signature !== "string") {
    logger.warn("GitHub webhook signature header 'x-hub-signature-256' is missing");
    return false;
  }

  const webhookSecret = config.github.webhookSecret;
  if (!webhookSecret) {
    logger.warn("GitHub webhookSecret is not configured. Rejecting all webhook requests.");
    return false;
  }

  const parts = signature.split("=");
  if (parts.length !== 2 || parts[0] !== "sha256") {
    logger.warn("GitHub webhook signature format is invalid");
    return false;
  }

  const expectedSignature = parts[1];
  const rawBody = (req as any).rawBody;
  if (!rawBody) {
    logger.warn("GitHub webhook rawBody is missing");
    return false;
  }

  const hmac = crypto.createHmac("sha256", webhookSecret);
  hmac.update(rawBody);
  const actualSignature = hmac.digest("hex");

  try {
    const expectedBuffer = Buffer.from(expectedSignature, "hex");
    const actualBuffer = Buffer.from(actualSignature, "hex");
    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
  } catch (err) {
    logger.error({ err }, "Signature verification error");
    return false;
  }
}

async function findRepositoryForGitHubId(githubRepositoryId: string) {
  return prisma.repository.findFirst({
    where: {
      OR: [
        { githubRepositoryId },
        { id: githubRepositoryId }
      ]
    },
    include: {
      project: true,
      githubInstallation: true
    }
  });
}

function installationMetadata(payload: any) {
  const account = payload.installation?.account || {};
  return {
    accountLogin: String(account.login || "unknown"),
    accountType: String(account.type || "unknown"),
    permissions: payload.installation?.permissions || {}
  };
}

async function upsertInstallationForRepository(
  dbRepo: Awaited<ReturnType<typeof findRepositoryForGitHubId>>,
  payload: any,
  installationId: string
) {
  if (!dbRepo) throw new Error("Repository is required to upsert GitHub installation");
  const metadata = installationMetadata(payload);
  return prisma.gitHubInstallation.upsert({
    where: { installationId },
    update: {
      ...metadata,
      suspendedAt: null
    },
    create: {
      organizationId: dbRepo.project.organizationId,
      installationId,
      ...metadata
    }
  });
}

async function linkRepositoryToInstallation(
  dbRepo: Awaited<ReturnType<typeof findRepositoryForGitHubId>>,
  repoPayload: any,
  installationId: string,
  payload: any
) {
  if (!dbRepo) return null;
  const installation = await upsertInstallationForRepository(dbRepo, payload, installationId);
  await prisma.repository.update({
    where: { id: dbRepo.id },
    data: {
      githubInstallationId: installation.id,
      githubRepositoryId: String(repoPayload.id),
      githubFullName: repoPayload.full_name || null,
      name: repoPayload.name || dbRepo.name,
      branch: repoPayload.default_branch || dbRepo.branch
    }
  });
  return installation;
}

// POST /webhooks/github
app.post("/webhooks/github", async (req: Request, res: Response, next: NextFunction) => {
  // 1. Verify GitHub Signature
  if (!verifyGithubSignature(req)) {
    return res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid webhook signature" });
  }

  // 2. Enforce delivery ID presence and check deduplication
  const deliveryId = req.headers["x-github-delivery"];
  if (!deliveryId || typeof deliveryId !== "string") {
    logger.warn("GitHub webhook delivery ID header 'x-github-delivery' is missing");
    return res.status(400).json({ error: "BAD_REQUEST", message: "Missing x-github-delivery header" });
  }

  const redisKey = `github-webhook:delivery:${deliveryId}`;
  try {
    const result = await redis.set(redisKey, "1", "EX", 86400, "NX"); // 24 hours TTL
    if (result !== "OK") {
      logger.info({ deliveryId }, "Duplicate webhook delivery detected. Ignoring.");
      return res.status(200).json({ status: "ignored_duplicate", deliveryId });
    }
  } catch (err) {
    logger.error({ err, deliveryId }, "Redis deduplication check failed");
  }

  // 3. Signature-based replay protection
  const signature = req.headers["x-hub-signature-256"];
  if (signature && typeof signature === "string") {
    const signatureKey = `github-webhook:signature:${signature}`;
    try {
      const sigResult = await redis.set(signatureKey, "1", "EX", 86400, "NX"); // 24 hours TTL
      if (sigResult !== "OK") {
        logger.warn({ signature }, "Duplicate signature (replay attack) detected. Ignoring.");
        return res.status(200).json({ status: "ignored_replay", message: "Duplicate signature" });
      }
    } catch (err) {
      logger.error({ err, signature }, "Redis signature replay check failed");
    }
  }

  const event = req.headers["x-github-event"] || "push";
  const payload = req.body;

  logger.info({ event }, "Received GitHub webhook payload");

  try {
    // 4. Handle push event
    if (event === "push") {
      // Handle branch deletion
      if (payload.deleted) {
        const repositoryId = payload.repository?.id ? String(payload.repository.id) : null;
        const branch = payload.ref ? payload.ref.replace("refs/heads/", "") : "main";
        if (repositoryId) {
          const dbRepo = await findRepositoryForGitHubId(repositoryId);
          if (dbRepo) {
            await prisma.auditLog.create({
              data: {
                orgId: dbRepo.project.organizationId,
                action: "github.branch.deleted",
                payload: { repositoryId, branch }
              }
            });
          }
        }
        return res.status(200).json({ status: "branch_deleted", message: "Branch deletion ignored for snapshotting" });
      }

      const repositoryId = payload.repository?.id ? String(payload.repository.id) : null;
      const installationId = payload.installation?.id ? String(payload.installation.id) : null;

      if (!repositoryId) {
        return res.status(400).json({ error: "BAD_REQUEST", message: "Missing repository ID" });
      }

      const dbRepo = await findRepositoryForGitHubId(repositoryId);
      if (!dbRepo) {
        logger.warn({ repositoryId }, "Repository not found in database");
        return res.status(404).json({ error: "NOT_FOUND", message: "Repository not found in database" });
      }

      if (!installationId) {
        logger.warn({ repositoryId }, "Push event payload is missing installation ID");
        return res.status(400).json({ error: "BAD_REQUEST", message: "Missing installation ID in payload" });
      }

      // Validate scope / installation mapping
      const githubInstall = dbRepo.githubInstallation;
      if (!githubInstall || githubInstall.installationId !== installationId || githubInstall.suspendedAt) {
        logger.warn({ repositoryId, installationId }, "Repository installation scope mismatch or unauthorized installation");
        return res.status(403).json({ error: "UNAUTHORIZED_INSTALLATION", message: "Repository installation scope mismatch" });
      }

      const gitUrl = payload.repository?.clone_url || "mock_repo_url";
      const branch = payload.ref ? payload.ref.replace("refs/heads/", "") : "main";
      const commitSha = payload.head_commit?.id || `commit_${Date.now()}`;

      // Write Audit Log
      await prisma.auditLog.create({
        data: {
          orgId: dbRepo.project.organizationId,
          action: "github.push.processed",
          payload: {
            repositoryId,
            commitSha,
            branch,
            gitUrl
          }
        }
      });

      // Trigger Archiving asynchronously (non-blocking webhook response)
      createCommitSnapshot(repositoryId, gitUrl, commitSha, branch)
        .catch(err => logger.error({ err }, "Async snapshot creation error"));

      return res.status(202).json({ status: "processing_snapshot", commitSha });
    }

    // 5. Handle installation event (created, deleted, suspend, unsuspend)
    if (event === "installation") {
      const action = payload.action;
      const installationId = payload.installation?.id ? String(payload.installation.id) : null;

      if (!installationId) {
        return res.status(400).json({ error: "BAD_REQUEST", message: "Missing installation ID" });
      }

      logger.info({ installationId, action }, "Handling installation event");

      if (action === "created" || action === "unsuspend") {
        const repos = payload.repositories || [];
        for (const repo of repos) {
          const repositoryId = String(repo.id);
          const dbRepo = await findRepositoryForGitHubId(repositoryId);
          if (dbRepo) {
            await linkRepositoryToInstallation(dbRepo, repo, installationId, payload);

            await prisma.auditLog.create({
              data: {
                orgId: dbRepo.project.organizationId,
                action: action === "created" ? "github.installation.created" : "github.installation.unsuspended",
                payload: {
                  repositoryId,
                  installationId,
                  repositoryName: repo.name
                }
              }
            });
          }
        }
        return res.status(200).json({
          status: action === "created" ? "installation_created_processed" : "installation_unsuspended_processed",
          installationId
        });
      }

      if (action === "deleted" || action === "suspend") {
        const installations = await prisma.gitHubInstallation.findMany({
          where: { installationId },
          include: { repositories: { include: { project: true } } }
        });
        for (const inst of installations) {
          if (action === "suspend") {
            await prisma.gitHubInstallation.update({
              where: { id: inst.id },
              data: { suspendedAt: new Date() }
            });
          } else {
            await prisma.repository.updateMany({
              where: { githubInstallationId: inst.id },
              data: { githubInstallationId: null }
            });
            await prisma.gitHubInstallation.delete({
              where: { id: inst.id }
            });
          }

          for (const repository of inst.repositories) {
            await prisma.auditLog.create({
              data: {
                orgId: repository.project.organizationId,
                action: action === "deleted" ? "github.installation.deleted" : "github.installation.suspended",
                payload: {
                  repositoryId: repository.id,
                  githubRepositoryId: repository.githubRepositoryId,
                  installationId
                }
              }
            });
          }
        }
        return res.status(200).json({
          status: action === "deleted" ? "installation_deleted_processed" : "installation_suspended_processed",
          installationId
        });
      }

      return res.status(200).json({ status: "installation_event_acknowledged", action });
    }

    // 5. Handle installation_repositories event
    if (event === "installation_repositories") {
      const action = payload.action; // 'added', 'removed'
      const installationId = payload.installation?.id ? String(payload.installation.id) : null;

      if (!installationId) {
        return res.status(400).json({ error: "BAD_REQUEST", message: "Missing installation ID" });
      }

      logger.info({ installationId, action }, "Handling installation_repositories event");

      if (action === "added") {
        const added = payload.repositories_added || [];
        for (const repo of added) {
          const repositoryId = String(repo.id);
          const dbRepo = await findRepositoryForGitHubId(repositoryId);
          if (dbRepo) {
            await linkRepositoryToInstallation(dbRepo, repo, installationId, payload);
            await prisma.auditLog.create({
              data: {
                orgId: dbRepo.project.organizationId,
                action: "github.installation.repository_added",
                payload: {
                  repositoryId,
                  installationId,
                  repositoryName: repo.name
                }
              }
            });
          }
        }
        return res.status(200).json({ status: "repositories_added_processed", installationId });
      }

      if (action === "removed") {
        const removed = payload.repositories_removed || [];
        for (const repo of removed) {
          const repositoryId = String(repo.id);
          const dbRepo = await findRepositoryForGitHubId(repositoryId);
          if (dbRepo) {
            await prisma.repository.updateMany({
              where: {
                id: dbRepo.id,
                githubInstallation: { installationId }
              },
              data: {
                githubInstallationId: null
              }
            });
            await prisma.auditLog.create({
              data: {
                orgId: dbRepo.project.organizationId,
                action: "github.installation.repository_removed",
                payload: {
                  repositoryId,
                  installationId,
                  repositoryName: repo.name
                }
              }
            });
          }
        }
        return res.status(200).json({ status: "repositories_removed_processed", installationId });
      }

      return res.status(200).json({ status: "installation_repositories_event_acknowledged", action });
    }

    res.status(200).json({ status: "ignored_event" });
  } catch (err) {
    next(err);
  }
});

// Error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error({ err, path: req.path }, "GitHub Worker error");
  if (err instanceof OpsPilotError) {
    return res.status(err.statusCode).json({ error: err.code, message: err.message });
  }
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: err.message });
});

let server: any;
if (process.env.NODE_ENV !== "test") {
  const port = 4001;
  server = app.listen(port, () => {
    logger.info(`OpsPilot GitHub Worker listening on port ${port}`);
  });
}

export { app, redis, server };
