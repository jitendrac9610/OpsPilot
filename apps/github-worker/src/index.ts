import express, { Request, Response, NextFunction } from "express";
import { logger, config, OpsPilotError } from "@opspilot/shared";
import { createCommitSnapshot } from "./archiver.js";

const app = express();
app.use(express.json());

// POST /webhooks/github
app.post("/webhooks/github", async (req: Request, res: Response, next: NextFunction) => {
  const event = req.headers["x-github-event"] || "push";
  const payload = req.body;

  logger.info({ event }, "Received GitHub webhook payload");

  try {
    if (event === "push") {
      const gitUrl = payload.repository?.clone_url || "mock_repo_url";
      const branch = payload.ref ? payload.ref.replace("refs/heads/", "") : "main";
      const commitSha = payload.head_commit?.id || `commit_${Date.now()}`;
      
      // Look up repository ID or simulate one
      const repositoryId = payload.repository?.id ? String(payload.repository.id) : "repo_123";

      // Trigger Archiving asynchronously (non-blocking webhook response)
      createCommitSnapshot(repositoryId, gitUrl, commitSha, branch)
        .catch(err => logger.error({ err }, "Async snapshot creation error"));

      return res.status(202).json({ status: "processing_snapshot", commitSha });
    }

    if (event === "installation") {
      logger.info({ installationId: payload.installation?.id }, "GitHub App installed");
      return res.status(200).json({ status: "installation_acknowledged" });
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

const port = 4001;
app.listen(port, () => {
  logger.info(`OpsPilot GitHub Worker listening on port ${port}`);
});
