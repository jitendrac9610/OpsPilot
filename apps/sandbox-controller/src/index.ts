import express, { Express } from "express";
import { Server } from "node:http";
import { logger } from "@opspilot/shared";
import { SandboxManager, SandboxProvisionError } from "./sandbox.js";
import { DependencyResolver } from "./dependencyResolver.js";
import { ServiceStartupManager } from "./serviceStartup.js";
import { TestRunner } from "./testRunner.js";
import { CleanupManager } from "./cleanup.js";

const app: Express = express();
app.use(express.json({ limit: "256kb" }));

const sandboxManager = new SandboxManager();
const dependencyResolver = new DependencyResolver();
const serviceStartupManager = new ServiceStartupManager();
const testRunner = new TestRunner();
const cleanupManager = new CleanupManager();

app.post("/api/sandboxes", async (req, res) => {
  try {
    const { snapshotId } = req.body;
    if (!snapshotId || typeof snapshotId !== "string") {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: "snapshotId is required" });
    }

    const sandboxId = await sandboxManager.createSandbox(snapshotId);
    const manifest = sandboxManager.getWorkspaceManifest(sandboxId);
    return res.status(201).json({
      id: sandboxId,
      status: "PROVISIONED",
      manifest
    });
  } catch (error) {
    logger.error({ error }, "Failed to create sandbox");
    if (error instanceof SandboxProvisionError) {
      return res.status(error.code === "SNAPSHOT_NOT_FOUND" ? 404 : 422).json({
        error: error.code,
        message: error.message
      });
    }
    return res.status(500).json({ error: "SANDBOX_PROVISIONING_FAILED", message: "Sandbox provisioning failed." });
  }
});

app.post("/api/sandboxes/:id/build", async (req, res) => {
  try {
    const sandboxId = req.params.id;
    const manifest = sandboxManager.getWorkspaceManifest(sandboxId);
    await sandboxManager.updateStatus(sandboxId, "INSTALLING_DEPENDENCIES");
    const result = await dependencyResolver.resolve(manifest.repositoryRoot, sandboxId, manifest.execution);
    await sandboxManager.updateStatus(sandboxId, result.success ? "DEPENDENCIES_INSTALLED" : "DEPENDENCY_INSTALL_FAILED");
    return res.status(result.success ? 200 : 422).json(result);
  } catch (error) {
    logger.error({ error }, "Dependency installation failed");
    return res.status(500).json({ error: "DEPENDENCY_INSTALL_FAILED", message: "Dependency installation failed." });
  }
});

app.post("/api/sandboxes/:id/start", async (req, res) => {
  try {
    const sandboxId = req.params.id;
    const { serviceId, environment = {} } = req.body;
    if (!serviceId || typeof serviceId !== "string") {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: "serviceId is required" });
    }

    const manifest = sandboxManager.getWorkspaceManifest(sandboxId);
    const service = manifest.execution.startCommands.find((candidate) => candidate.id === serviceId);
    if (!service) {
      return res.status(404).json({ error: "SERVICE_COMMAND_NOT_DISCOVERED", message: `Unknown serviceId ${serviceId}` });
    }

    const allowedEnvironment = new Set(manifest.execution.requiredEnvironment.map((item) => item.name));
    const filteredEnvironment = Object.fromEntries(
      Object.entries(environment as Record<string, string>)
        .filter(([key, value]) => allowedEnvironment.has(key) && typeof value === "string")
    );

    await sandboxManager.updateStatus(sandboxId, "STARTING_SERVICES");
    const result = await serviceStartupManager.startService(
      sandboxId,
      manifest.repositoryRoot,
      service,
      filteredEnvironment
    );
    await sandboxManager.updateStatus(sandboxId, result.success ? "SERVICES_RUNNING" : "SERVICE_STARTUP_FAILED");
    return res.status(result.success ? 200 : 422).json(result);
  } catch (error) {
    logger.error({ error }, "Service startup failed");
    return res.status(500).json({ error: "SERVICE_STARTUP_FAILED", message: "Service startup failed." });
  }
});

app.post("/api/sandboxes/:id/test", async (req, res) => {
  try {
    const sandboxId = req.params.id;
    const type = req.body.type as "unit" | "integration" | "e2e";
    if (!["unit", "integration", "e2e"].includes(type)) {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: "type must be unit, integration, or e2e" });
    }

    const manifest = sandboxManager.getWorkspaceManifest(sandboxId);
    await sandboxManager.updateStatus(sandboxId, `RUNNING_${type.toUpperCase()}_TESTS`);
    const result = await testRunner.runTests(sandboxId, manifest.repositoryRoot, type, manifest.execution);
    await sandboxManager.updateStatus(sandboxId, result.success ? "TESTS_PASSED" : "TESTS_FAILED");
    return res.status(result.success ? 200 : 422).json(result);
  } catch (error) {
    logger.error({ error }, "Test execution failed");
    return res.status(500).json({ error: "TEST_EXECUTION_FAILED", message: "Test execution failed." });
  }
});

app.delete("/api/sandboxes/:id", async (req, res) => {
  try {
    const sandboxId = req.params.id;
    const workspaceDir = sandboxManager.getWorkspaceDir(sandboxId);
    await sandboxManager.updateStatus(sandboxId, "TERMINATING");
    await serviceStartupManager.stopAll(sandboxId);
    await cleanupManager.deleteWorkspaceDir(workspaceDir);
    await sandboxManager.updateStatus(sandboxId, "DESTROYED");
    return res.json({ success: true, message: `Sandbox ${sandboxId} destroyed.` });
  } catch (error) {
    logger.error({ error }, "Sandbox cleanup failed");
    return res.status(500).json({ error: "SANDBOX_CLEANUP_FAILED", message: "Sandbox cleanup failed." });
  }
});

const PORT = parseInt(process.env.SANDBOX_CONTROLLER_PORT || "4010", 10);
const server: Server = app.listen(PORT, () => {
  logger.info({ port: PORT }, "Sandbox Controller HTTP API server listening");
});

export { app, server };
export * from "./sandbox.js";
export * from "./executionManifest.js";
export * from "./containerRunner.js";
export * from "./dependencyResolver.js";
export * from "./serviceStartup.js";
export * from "./telemetry.js";
export * from "./testRunner.js";
export * from "./cleanup.js";
