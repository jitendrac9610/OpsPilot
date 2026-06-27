import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";

// Load environment variables before importing routes or shared config
const rootEnv = path.resolve(process.cwd(), ".env");
const parentEnv = path.resolve(process.cwd(), "../../.env");
if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv });
} else if (fs.existsSync(parentEnv)) {
  dotenv.config({ path: parentEnv });
}

import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { logger, config, OpsPilotError } from "@opspilot/shared";
import { authRouter } from "./routes/auth.js";
import { orgRouter } from "./routes/orgs.js";
import { projectRouter } from "./routes/projects.js";
import { billingRouter } from "./routes/billing.js";
import { auditRouter } from "./routes/audit.js";
import { repositoryRouter } from "./routes/repositories.js";
import { incidentRouter } from "./routes/incidents.js";
import { publicRouter } from "./routes/public.js";
import { adminRouter } from "./routes/admin.js";
import { evaluationRouter } from "./routes/evaluation.js";
import { sandboxRouter } from "./routes/sandbox.js";
import { diagnosticRunsRouter } from "./routes/diagnosticRuns.js";
import { githubRouter } from "./routes/github.js";

const app = express();

app.use(cors({ origin: config.clientUrl }));
app.use(express.json());

// Bind routing groups
app.use("/api/auth", authRouter);
app.use("/api/organizations", orgRouter);
app.use("/api/projects", projectRouter);
app.use("/api/repositories", repositoryRouter);
app.use("/api/diagnostic-runs", diagnosticRunsRouter);
app.use("/api/github", githubRouter);
app.use("/api", billingRouter);
app.use("/api/audit-logs", auditRouter);
app.use("/api/incidents", incidentRouter);
app.use("/api/public", publicRouter);
app.use("/api/admin", adminRouter);
app.use("/api/evaluation", evaluationRouter);
app.use("/api/sandboxes", sandboxRouter);

// Global error handler middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error({ err, path: req.path }, "API error occurred");

  if (err instanceof OpsPilotError) {
    return res.status(err.statusCode).json({
      error: err.code,
      message: err.message,
      details: err.details
    });
  }

  res.status(500).json({
    error: "INTERNAL_SERVER_ERROR",
    message: "An unexpected server-side error occurred"
  });
});

app.listen(config.port, () => {
  logger.info(`OpsPilot Control API listening on port ${config.port} in ${config.nodeEnv} mode`);
});
