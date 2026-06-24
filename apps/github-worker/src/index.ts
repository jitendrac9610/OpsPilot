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

// POST /webhooks/github
app.post("/webhooks/github", async (req: Request, res: Response, next: NextFunction) => {
  // 1. Verify GitHub Signature
  if (!verifyGithubSignature(req)) {
    return res.status(401).json({ error: "UNAUTHORIZED", message: "Invalid webhook signature" });
  }

  // 2. Redis-based delivery ID deduplication
  const deliveryId = req.headers["x-github-delivery"];
  if (deliveryId && typeof deliveryId === "string") {
    const redisKey = `github-webhook:delivery:${deliveryId}`;
    try {
      const result = await (redis as any).set(redisKey, "1", "NX", "EX", 86400); // 24 hours TTL
      if (result !== "OK") {
        logger.info({ deliveryId }, "Duplicate webhook delivery detected. Ignoring.");
        return res.status(200).json({ status: "ignored_duplicate", deliveryId });
      }
    } catch (err) {
      logger.error({ err, deliveryId }, "Redis deduplication check failed");
    }
  }

  const event = req.headers["x-github-event"] || "push";
  const payload = req.body;

  logger.info({ event }, "Received GitHub webhook payload");

  try {
    // 3. Handle push event
    if (event === "push") {
      const repositoryId = payload.repository?.id ? String(payload.repository.id) : null;
      const installationId = payload.installation?.id ? String(payload.installation.id) : null;

      if (!repositoryId) {
        return res.status(400).json({ error: "BAD_REQUEST", message: "Missing repository ID" });
      }

      // Validate scope / installation mapping
      if (installationId) {
        const githubInstall = await prisma.gitHubInstallation.findUnique({
          where: { repositoryId }
        });
        if (!githubInstall || githubInstall.installationId !== installationId) {
          logger.warn({ repositoryId, installationId }, "Repository installation scope mismatch or unauthorized installation");
          return res.status(403).json({ error: "UNAUTHORIZED_INSTALLATION", message: "Repository installation scope mismatch" });
        }
      }

      const gitUrl = payload.repository?.clone_url || "mock_repo_url";
      const branch = payload.ref ? payload.ref.replace("refs/heads/", "") : "main";
      const commitSha = payload.head_commit?.id || `commit_${Date.now()}`;

      // Trigger Archiving asynchronously (non-blocking webhook response)
      createCommitSnapshot(repositoryId, gitUrl, commitSha, branch)
        .catch(err => logger.error({ err }, "Async snapshot creation error"));

      return res.status(202).json({ status: "processing_snapshot", commitSha });
    }

    // 4. Handle installation event
    if (event === "installation") {
      const action = payload.action; // 'created', 'deleted', 'suspend', 'unsuspend'
      const installationId = payload.installation?.id ? String(payload.installation.id) : null;

      if (!installationId) {
        return res.status(400).json({ error: "BAD_REQUEST", message: "Missing installation ID" });
      }

      logger.info({ installationId, action }, "Handling installation event");

      if (action === "created") {
        const repos = payload.repositories || [];
        for (const repo of repos) {
          const repositoryId = String(repo.id);
          const dbRepo = await prisma.repository.findUnique({
            where: { id: repositoryId },
            include: { project: true }
          });
          if (dbRepo) {
            await prisma.gitHubInstallation.upsert({
              where: { repositoryId },
              update: { installationId },
              create: { repositoryId, installationId }
            });

            await prisma.auditLog.create({
              data: {
                orgId: dbRepo.project.organizationId,
                action: "github.installation.created",
                payload: {
                  repositoryId,
                  installationId,
                  repositoryName: repo.name
                }
              }
            });
          }
        }
        return res.status(200).json({ status: "installation_created_processed", installationId });
      }

      if (action === "deleted") {
        const installations = await prisma.gitHubInstallation.findMany({
          where: { installationId },
          include: { repository: { include: { project: true } } }
        });
        for (const inst of installations) {
          await prisma.gitHubInstallation.delete({
            where: { id: inst.id }
          });
          await prisma.auditLog.create({
            data: {
              orgId: inst.repository.project.organizationId,
              action: "github.installation.deleted",
              payload: {
                repositoryId: inst.repositoryId,
                installationId
              }
            }
          });
        }
        return res.status(200).json({ status: "installation_deleted_processed", installationId });
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
          const dbRepo = await prisma.repository.findUnique({
            where: { id: repositoryId },
            include: { project: true }
          });
          if (dbRepo) {
            await prisma.gitHubInstallation.upsert({
              where: { repositoryId },
              update: { installationId },
              create: { repositoryId, installationId }
            });
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
          const dbRepo = await prisma.repository.findUnique({
            where: { id: repositoryId },
            include: { project: true }
          });
          if (dbRepo) {
            await prisma.gitHubInstallation.deleteMany({
              where: { repositoryId, installationId }
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
