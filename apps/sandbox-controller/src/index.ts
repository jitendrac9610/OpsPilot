import express, { Express } from "express";
import { Server } from "node:http";
import { logger } from "@opspilot/shared";
import { SandboxManager } from "./sandbox.js";
import { DependencyResolver } from "./dependencyResolver.js";
import { ServiceStartupManager } from "./serviceStartup.js";
import { TestRunner } from "./testRunner.js";
import { CleanupManager } from "./cleanup.js";

const app: Express = express();
app.use(express.json());

const sandboxManager = new SandboxManager();
const dependencyResolver = new DependencyResolver();
const serviceStartupManager = new ServiceStartupManager();
const testRunner = new TestRunner();
const cleanupManager = new CleanupManager();

const sandboxWorkspaces = new Map<string, string>();

app.post("/api/sandboxes", async (req, res) => {
  try {
    const { snapshotId } = req.body;
    if (!snapshotId) {
      return res.status(400).json({ error: "Missing snapshotId parameter" });
    }

    const sandboxId = await sandboxManager.createSandbox(snapshotId);
    const workspaceDir = sandboxManager.getWorkspaceDir(sandboxId);
    sandboxWorkspaces.set(sandboxId, workspaceDir);

    return res.status(201).json({ id: sandboxId, workspaceDir });
  } catch (err: any) {
    logger.error({ err }, "Failed to create sandbox");
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

app.post("/api/sandboxes/:id/build", async (req, res) => {
  try {
    const sandboxId = req.params.id;
    const workspaceDir = sandboxWorkspaces.get(sandboxId) || sandboxManager.getWorkspaceDir(sandboxId);

    await sandboxManager.updateStatus(sandboxId, "BUILDING");
    const result = await dependencyResolver.resolve(workspaceDir, sandboxId);
    
    if (result.success) {
      await sandboxManager.updateStatus(sandboxId, "BUILT");
    } else {
      await sandboxManager.updateStatus(sandboxId, "BUILD_FAILED");
    }

    return res.json(result);
  } catch (err: any) {
    logger.error({ err }, "Build execution failed");
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

app.post("/api/sandboxes/:id/start", async (req, res) => {
  try {
    const sandboxId = req.params.id;
    const { name, command, args, port } = req.body;

    if (!name || !command) {
      return res.status(400).json({ error: "Missing name or command parameter" });
    }

    const workspaceDir = sandboxWorkspaces.get(sandboxId) || sandboxManager.getWorkspaceDir(sandboxId);
    await sandboxManager.updateStatus(sandboxId, "STARTING_SERVICES");

    const result = await serviceStartupManager.startService(
      sandboxId,
      workspaceDir,
      name,
      command,
      args || [],
      port
    );

    if (result.success) {
      await sandboxManager.updateStatus(sandboxId, "SERVICES_RUNNING");
    } else {
      await sandboxManager.updateStatus(sandboxId, "SERVICE_STARTUP_FAILED");
    }

    return res.json(result);
  } catch (err: any) {
    logger.error({ err }, "Service startup failed");
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

app.post("/api/sandboxes/:id/test", async (req, res) => {
  try {
    const sandboxId = req.params.id;
    const { type, command } = req.body;

    if (!type) {
      return res.status(400).json({ error: "Missing test type parameter" });
    }

    const workspaceDir = sandboxWorkspaces.get(sandboxId) || sandboxManager.getWorkspaceDir(sandboxId);
    await sandboxManager.updateStatus(sandboxId, "TESTING");

    const result = await testRunner.runTests(
      sandboxId,
      workspaceDir,
      type,
      command || "npm test"
    );

    if (result.success) {
      await sandboxManager.updateStatus(sandboxId, "TESTS_PASSED");
    } else {
      await sandboxManager.updateStatus(sandboxId, "TESTS_FAILED");
    }

    return res.json(result);
  } catch (err: any) {
    logger.error({ err }, "Test runner execution failed");
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

app.delete("/api/sandboxes/:id", async (req, res) => {
  try {
    const sandboxId = req.params.id;
    const workspaceDir = sandboxWorkspaces.get(sandboxId) || sandboxManager.getWorkspaceDir(sandboxId);

    await sandboxManager.updateStatus(sandboxId, "TERMINATING");

    const procs = serviceStartupManager.getActiveProcesses(sandboxId);
    await cleanupManager.terminateProcesses(procs);
    serviceStartupManager.clearProcesses(sandboxId);

    await cleanupManager.deleteWorkspaceDir(workspaceDir);
    sandboxWorkspaces.delete(sandboxId);

    await sandboxManager.updateStatus(sandboxId, "DESTROYED");

    return res.json({ success: true, message: `Sandbox ${sandboxId} destroyed successfully.` });
  } catch (err: any) {
    logger.error({ err }, "Cleanup execution failed");
    return res.status(500).json({ error: err.message || "Internal server error" });
  }
});

const PORT = parseInt(process.env.SANDBOX_CONTROLLER_PORT || "4010", 10);
const server: Server = app.listen(PORT, () => {
  logger.info({ port: PORT }, "Sandbox Controller HTTP API server listening");
});

export { app, server };
export * from "./sandbox.js";
export * from "./dependencyResolver.js";
export * from "./serviceStartup.js";
export * from "./telemetry.js";
export * from "./testRunner.js";
export * from "./cleanup.js";
