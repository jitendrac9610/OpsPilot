import { prisma } from "@opspilot/database";
import { createCommitSnapshot } from "@opspilot/repository-intelligence";
import { logger, config, storage } from "@opspilot/shared";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "node:crypto";
import { EvidenceEvent } from "@opspilot/schemas";
import {
  AuthBootstrapper,
  FailureLocalizer,
  StatefulWorkflowPlanner,
  WorkflowDiscoverer
} from "@opspilot/workflow-engine";
import {
  AssertionEngine,
  CorrelationManager,
  WorkflowDrivers,
  getAffectedTables,
  runDatabaseCleanup
} from "@opspilot/workflow-core";
import { DiagnosticWorkerError } from "./errors.js";
import { progressForStage } from "./heartbeat.js";

class UnsupportedWorkflowStepError extends Error {
  public readonly code = "UNSUPPORTED_WORKFLOW_STEP";

  constructor(public readonly stepType: string) {
    super(`Unsupported workflow step type: ${stepType}`);
    this.name = "UnsupportedWorkflowStepError";
  }
}

export interface DiagnosticRunOrchestratorOptions {
  signal?: AbortSignal;
  attempt?: number;
  workerId?: string;
}

export async function getRemoteHeadSha(gitUrl: string, branch: string): Promise<string> {
  if (gitUrl.startsWith("mock_") || gitUrl.includes("mock-repo")) {
    return `mock_commit_${Date.now()}`;
  }

  return new Promise((resolve, reject) => {
    const child = spawn("git", ["ls-remote", gitUrl, branch], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      if (code === 0) {
        const parts = stdout.trim().split(/\s+/);
        if (parts[0]) {
          resolve(parts[0]);
          return;
        }
      }
      reject(new Error(`Failed to resolve commit SHA via git ls-remote: ${stderr || stdout || ("exit code " + code)}`));
    });
  });
}

export class DiagnosticRunOrchestrator {
  private id: string;
  private options: DiagnosticRunOrchestratorOptions = {};

  constructor(id: string) {
    this.id = id;
  }

  async run(options: DiagnosticRunOrchestratorOptions = {}): Promise<void> {
    this.options = options;
    logger.info({ diagnosticRunId: this.id }, "Starting DiagnosticRun orchestrator");

    // Fetch the run
    let run = await prisma.diagnosticRun.findUnique({
      where: { id: this.id },
      include: { repository: true }
    });

    if (!run) {
      throw new Error(`DiagnosticRun ${this.id} not found`);
    }

    if (run.status === "CANCELLED" || run.status === "COMPLETED" || run.status === "FAILED") {
      logger.info({ diagnosticRunId: this.id, status: run.status }, "DiagnosticRun is already in final state. Skipping.");
      if (run.status === "CANCELLED") {
        const currentSandboxId = (run.artifacts as any)?.sandboxId;
        if (currentSandboxId) {
          await this.cleanupSandbox(currentSandboxId);
        }
      }
      return;
    }

    // Mark as running if PENDING
    if (run.status === "PENDING") {
      run = await prisma.diagnosticRun.update({
        where: { id: this.id },
        data: {
          status: "RUNNING",
          stage: "CLONING",
          attempt: options.attempt ?? run.attempt + 1,
          workerId: options.workerId,
          startedAt: run.startedAt ?? new Date(),
          lastHeartbeatAt: new Date(),
          progress: progressForStage("CLONING"),
          failureCode: null,
          failureMessage: null,
          retryable: false
        },
        include: { repository: true }
      });
    }

    let snapshotId = run.snapshotId;
    let artifacts = (run.artifacts as any) || {};
    let sandboxId = artifacts.sandboxId;
    let baseApiUrl = artifacts.baseApiUrl;

    // Self-healing recovery checks on resume
    const stagesAfterSandboxStart = ["BOOTSTRAP_AUTH", "PLANNING_WORKFLOW", "EXECUTING_WORKFLOW", "LOCALIZING_FAILURE"];
    if (stagesAfterSandboxStart.includes(run.stage) && sandboxId) {
      logger.info({ diagnosticRunId: this.id, sandboxId }, "Resuming run. Checking sandbox services status.");
      let servicesActive = false;
      let newEndpoints: any[] = [];
      let newServices: any[] = [];
      try {
        const checkRes = await this.fetch(`${config.services.sandboxControllerUrl}/api/sandboxes/${sandboxId}/services`);
        if (checkRes.ok) {
          const body = await checkRes.json() as any;
          if (body.success && Array.isArray(body.services) && body.services.length > 0) {
            servicesActive = true;
            newServices = body.services;
            newEndpoints = body.services.flatMap((s: any) => s.endpoints || []);
          }
        }
      } catch (err: any) {
        logger.warn({ err: err.message }, "Error checking sandbox services status during resume");
      }

      if (!servicesActive) {
        logger.info({ diagnosticRunId: this.id }, "Sandbox services are inactive. Attempting self-healing recovery.");
        try {
          const runRes = await this.fetch(`${config.services.sandboxControllerUrl}/api/sandboxes/${sandboxId}/run`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ environment: {} })
          });
          if (runRes.ok) {
            const runResult = await runRes.json() as any;
            if (runResult.success) {
              const apiEndpoint = runResult.endpoints?.find((e: any) => e.kind === "api" || e.kind === "application") || runResult.endpoints?.[0];
              baseApiUrl = apiEndpoint ? apiEndpoint.externalUrl : "http://localhost:4000";
              artifacts.baseApiUrl = baseApiUrl;
              newEndpoints = runResult.endpoints || [];
              newServices = runResult.services || [];

              // Save the updated endpoints back to the run
              run = await prisma.diagnosticRun.update({
                where: { id: this.id },
                data: {
                  discoveredServices: {
                    ...(run.discoveredServices as any || {}),
                    sandboxEndpoints: newEndpoints,
                    sandboxServices: newServices
                  },
                  artifacts: artifacts
                },
                include: { repository: true }
              });
              logger.info({ diagnosticRunId: this.id }, "Self-healing: sandbox services recovered successfully.");
              servicesActive = true;
            }
          }
        } catch (recoveryErr: any) {
          logger.warn({ err: recoveryErr.message }, "Self-healing recovery via startup failed.");
        }

        if (!servicesActive) {
          logger.warn({ diagnosticRunId: this.id }, "Recovery failed. Rolling back to SANDBOX_PROVISION for a clean run.");
          delete artifacts.sandboxId;
          delete artifacts.baseApiUrl;
          sandboxId = undefined;
          baseApiUrl = undefined;
          run = await prisma.diagnosticRun.update({
            where: { id: this.id },
            data: {
              stage: "SANDBOX_PROVISION",
              artifacts: artifacts
            },
            include: { repository: true }
          });
        }
      } else {
        logger.info({ diagnosticRunId: this.id }, "Sandbox services are active. No self-healing required.");
      }
    }

    if (await this.checkCancelled(sandboxId)) return;
    // ==========================================
    // Stage 1: CLONING (Git snapshot creation)
    // ==========================================
    if (run.stage === "CLONING") {
      logger.info({ diagnosticRunId: this.id }, "Stage: CLONING");
      try {
        const repo = run.repository;
        const commitSha = await getRemoteHeadSha(repo.gitUrl, repo.branch);
        
        // Check if snapshot already exists
        let snapshot = await prisma.repositorySnapshot.findFirst({
          where: { repositoryId: repo.id, commitSha }
        });

        if (!snapshot || snapshot.status !== "READY") {
          logger.info({ repoId: repo.id, commitSha }, "Snapshot not found. Creating exact commit snapshot.");
          const snapshotResult = await createCommitSnapshot({
            repositoryId: repo.id,
            gitUrl: repo.gitUrl,
            commitSha,
            branch: repo.branch,
            source: "diagnostic-worker"
          });
          snapshot = await prisma.repositorySnapshot.findUnique({
            where: { id: snapshotResult.snapshotId }
          });
          if (!snapshot || snapshot.status !== "READY") {
            throw new Error(`Repository snapshot creation failed for commit ${commitSha}`);
          }
        }

        snapshotId = snapshot.id;
        run = await prisma.diagnosticRun.update({
          where: { id: this.id },
          data: {
            snapshotId: snapshot.id,
            stage: "DISCOVERING"
          },
          include: { repository: true }
        });
      } catch (err: any) {
        await this.fail(err.message, "CLONING");
        return;
      }
    }

    if (await this.checkCancelled(sandboxId)) return;
    // ==========================================
    // Stage 2: DISCOVERING (Capability detection)
    // ==========================================
    if (run.stage === "DISCOVERING") {
      logger.info({ diagnosticRunId: this.id }, "Stage: DISCOVERING");
      try {
        if (!snapshotId) throw new Error("Missing snapshotId for discovery");
        const snapshot = await prisma.repositorySnapshot.findUnique({ where: { id: snapshotId } });
        if (!snapshot) throw new Error(`Snapshot ${snapshotId} not found`);

        let capProfile = await prisma.capabilityProfile.findUnique({
          where: { snapshotId }
        });

        if (!capProfile) {
          logger.info({ snapshotId }, "Triggering discovery worker...");
          const discRes = await this.fetch(`${config.services.discoveryWorkerUrl}/discover`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              repositoryId: run.repositoryId,
              commitSha: snapshot.commitSha,
              archiveUrl: snapshot.archiveUrl
            })
          });

          if (!discRes.ok) {
            throw new Error(`Discovery worker failed: ${await discRes.text()}`);
          }

          // wait a brief moment for DB to commit capability profile
          let attempts = 0;
          while (!capProfile && attempts < 10) {
            await this.sleep(500);
            capProfile = await prisma.capabilityProfile.findUnique({ where: { snapshotId } });
            attempts++;
          }
        }

        run = await prisma.diagnosticRun.update({
          where: { id: this.id },
          data: {
            discoveredServices: (capProfile?.profile || {}) as any,
            stage: "INDEXING"
          },
          include: { repository: true }
        });
      } catch (err: any) {
        await this.fail(err.message, "DISCOVERING");
        return;
      }
    }

    if (await this.checkCancelled(sandboxId)) return;
    // ==========================================
    // Stage 3: INDEXING (AST indexing & Static audit)
    // ==========================================
    if (run.stage === "INDEXING") {
      logger.info({ diagnosticRunId: this.id }, "Stage: INDEXING");
      try {
        if (!snapshotId) throw new Error("Missing snapshotId for indexing");

        // The discovery worker automatically triggers indexing & graph generation when it completes.
        // So we can poll database for the completion logs, architecture version and findings.
        let archVersion = await prisma.architectureVersion.findFirst({
          where: { snapshotId }
        });

        let attempts = 0;
        // Wait up to 60 seconds for indexing to finish asynchronously
        while (!archVersion && attempts < 60) {
          await this.sleep(1000);
          archVersion = await prisma.architectureVersion.findFirst({
            where: { snapshotId }
          });
          attempts++;
        }

        if (!archVersion) {
          throw new Error("Indexing / Graph worker timed out generating architecture version.");
        }

        // Fetch findings from database
        const findings = await prisma.finding.findMany({
          where: { repositoryId: run.repositoryId }
        });

        run = await prisma.diagnosticRun.update({
          where: { id: this.id },
          data: {
            findings: findings as any,
            stage: "SANDBOX_PROVISION"
          },
          include: { repository: true }
        });
      } catch (err: any) {
        await this.fail(err.message, "INDEXING");
        return;
      }
    }

    if (await this.checkCancelled(sandboxId)) return;
    // ==========================================
    // Stage 4: SANDBOX_PROVISION (Allocate sandbox)
    // ==========================================
    sandboxId = artifacts.sandboxId;
    if (run.stage === "SANDBOX_PROVISION") {
      logger.info({ diagnosticRunId: this.id }, "Stage: SANDBOX_PROVISION");
      try {
        if (!snapshotId) throw new Error("Missing snapshotId for sandbox provisioning");

        if (!sandboxId) {
          logger.info({ snapshotId }, "Allocating sandbox for diagnosis");
          const sandboxRes = await this.fetch(`${config.services.sandboxControllerUrl}/api/sandboxes`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ snapshotId })
          });
          if (!sandboxRes.ok) {
            throw new Error(`Failed to allocate sandbox: ${await sandboxRes.text()}`);
          }
          const sandboxData = await sandboxRes.json() as { id: string };
          sandboxId = sandboxData.id;
          artifacts.sandboxId = sandboxId;
        }

        run = await prisma.diagnosticRun.update({
          where: { id: this.id },
          data: {
            artifacts: artifacts,
            stage: "SANDBOX_START"
          },
          include: { repository: true }
        });
      } catch (err: any) {
        await this.fail(err.message, "SANDBOX_PROVISION");
        return;
      }
    }

    if (await this.checkCancelled(sandboxId)) return;
    // ==========================================
    // Stage 5: SANDBOX_START (Run sandbox services)
    // ==========================================
    baseApiUrl = artifacts.baseApiUrl;
    if (run.stage === "SANDBOX_START") {
      logger.info({ diagnosticRunId: this.id }, "Stage: SANDBOX_START");
      try {
        if (!sandboxId) throw new Error("Missing sandboxId to start services");

        logger.info({ sandboxId }, "Starting sandbox container services");
        const runRes = await this.fetch(`${config.services.sandboxControllerUrl}/api/sandboxes/${sandboxId}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ environment: {} })
        });
        if (!runRes.ok) {
          throw new Error(`Failed to run sandbox services: ${await runRes.text()}`);
        }
        const runResult = await runRes.json() as any;

        const apiEndpoint = runResult.endpoints?.find((e: any) => e.kind === "api" || e.kind === "application") || runResult.endpoints?.[0];
        baseApiUrl = apiEndpoint ? apiEndpoint.externalUrl : "http://localhost:4000";
        artifacts.baseApiUrl = baseApiUrl;
        artifacts.sandboxStartedAt = new Date().toISOString();

        run = await prisma.diagnosticRun.update({
          where: { id: this.id },
          data: {
            discoveredServices: {
              ...(run.discoveredServices as any || {}),
              sandboxEndpoints: runResult.endpoints || [],
              sandboxServices: runResult.services || []
            },
            artifacts: artifacts,
            stage: "BOOTSTRAP_AUTH"
          },
          include: { repository: true }
        });
      } catch (err: any) {
        await this.fail(err.message, "SANDBOX_START");
        return;
      }
    }

    if (await this.checkCancelled(sandboxId)) return;
    // ==========================================
    // Stage 6: BOOTSTRAP_AUTH (Bootstrap users/sessions)
    // ==========================================
    let authSessionsData = artifacts.authSessions;
    if (run.stage === "BOOTSTRAP_AUTH") {
      logger.info({ diagnosticRunId: this.id }, "Stage: BOOTSTRAP_AUTH");
      try {
        if (!baseApiUrl) throw new Error("Missing baseApiUrl for authentication bootstrap");
        if (!snapshotId) throw new Error("Missing snapshotId for auth bootstrap");

        const snapshot = await prisma.repositorySnapshot.findUnique({ where: { id: snapshotId } });
        if (!snapshot) throw new Error(`Snapshot ${snapshotId} not found`);

        // Load contracts
        const tempDir = path.join(config.tempRoot, `opspilot-diagnose-${run.id}-${Date.now()}`);
        await fs.promises.mkdir(tempDir, { recursive: true });
        const zipBuffer = await storage.downloadSnapshot(snapshot.archiveUrl);
        const { extractArchiveSafely } = await import("@opspilot/shared");
        await extractArchiveSafely(zipBuffer, tempDir);

        const discoverer = new WorkflowDiscoverer(false);
        const contracts = await discoverer.discoverContracts(tempDir);
        const wsContracts = await discoverer.discoverWebSocketContracts(tempDir);
        const webhookContracts = await discoverer.discoverWebhookContracts(tempDir);
        const queueContracts = await discoverer.discoverQueueContracts(tempDir);
        const browserContracts = await discoverer.discoverBrowserContracts(tempDir);
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});

        // Save discovered contracts to DiagnosticRun
        artifacts.wsContracts = wsContracts;
        artifacts.webhookContracts = webhookContracts;
        artifacts.queueContracts = queueContracts;
        artifacts.browserContracts = browserContracts;
        await prisma.diagnosticRun.update({
          where: { id: this.id },
          data: {
            contracts: contracts as any,
            artifacts: artifacts as any
          }
        });

        // Bootstrap
        const authBootstrapper = new AuthBootstrapper(baseApiUrl);
        const authSessions = await authBootstrapper.bootstrapRequiredRoles(contracts);

        // Convert Map to plain object for storage
        authSessionsData = {};
        for (const [role, session] of authSessions.entries()) {
          authSessionsData[role] = session;
        }
        artifacts.authSessions = authSessionsData;

        run = await prisma.diagnosticRun.update({
          where: { id: this.id },
          data: {
            artifacts: artifacts,
            stage: "PLANNING_WORKFLOW"
          },
          include: { repository: true }
        });
      } catch (err: any) {
        await this.fail(err.message, "BOOTSTRAP_AUTH");
        return;
      }
    }

    if (await this.checkCancelled(sandboxId)) return;
    // ==========================================
    // Stage 7: PLANNING_WORKFLOW (Workflow planner)
    // ==========================================
    let plan = run.workflows as any;
    if (run.stage === "PLANNING_WORKFLOW") {
      logger.info({ diagnosticRunId: this.id }, "Stage: PLANNING_WORKFLOW");
      try {
        if (!baseApiUrl) throw new Error("Missing baseApiUrl for workflow planning");
        const contracts = run.contracts as any[];
        if (!contracts) throw new Error("Missing contracts for workflow planning");
        const wsContracts = (run.artifacts as any)?.wsContracts || [];
        const webhookContracts = (run.artifacts as any)?.webhookContracts || [];
        const queueContracts = (run.artifacts as any)?.queueContracts || [];
        const browserContracts = (run.artifacts as any)?.browserContracts || [];

        const planner = new StatefulWorkflowPlanner(baseApiUrl);
        plan = await planner.planWorkflow(run.repository.projectId, contracts, wsContracts, webhookContracts, queueContracts, browserContracts);

        // Save synthetic workflow to DB
        const workflowName = `Diagnostic Workflow - ${Date.now()}`;
        const workflow = await prisma.syntheticWorkflow.create({
          data: {
            projectId: run.repository.projectId,
            name: workflowName,
            description: plan.description,
            steps: plan.steps as any
          }
        });

        artifacts.workflowId = workflow.id;

        run = await prisma.diagnosticRun.update({
          where: { id: this.id },
          data: {
            workflows: plan,
            artifacts: artifacts,
            stage: "EXECUTING_WORKFLOW"
          },
          include: { repository: true }
        });
      } catch (err: any) {
        await this.fail(err.message, "PLANNING_WORKFLOW");
        return;
      }
    }

    if (await this.checkCancelled(sandboxId)) return;
    // ==========================================
    // Stage 8: EXECUTING_WORKFLOW (Workflow replay & asserts)
    // ==========================================
    let workflowRunId = artifacts.workflowRunId;
    let correlationId = artifacts.correlationId;
    let overallSuccess = true;
    let failedStepName = "";
    let stepFailureReason = "";

    if (run.stage === "EXECUTING_WORKFLOW") {
      logger.info({ diagnosticRunId: this.id }, "Stage: EXECUTING_WORKFLOW");
      try {
        if (!baseApiUrl) throw new Error("Missing baseApiUrl for workflow execution");
        if (!plan) throw new Error("Missing planned workflow steps");

        const correlationManager = new CorrelationManager(false);

        if (!workflowRunId) {
          workflowRunId = await correlationManager.startWorkflowRun(artifacts.workflowId);
          const runRecord = await prisma.workflowRun.findUnique({ where: { id: workflowRunId } });
          correlationId = runRecord?.correlationId || `trace-${Math.random().toString(36).substring(2, 9)}`;

          artifacts.workflowRunId = workflowRunId;
          artifacts.correlationId = correlationId;
          await prisma.diagnosticRun.update({
            where: { id: this.id },
            data: { artifacts }
          });
        }

        const drivers = new WorkflowDrivers(baseApiUrl);
        const assertionEngine = new AssertionEngine();

        // Prepare variables
        const variables: Record<string, any> = { ...(plan.initialVariables || {}) };
        
        // Inject auth sessions to variables
        if (authSessionsData) {
          const userSession = authSessionsData["user"] || Object.values(authSessionsData)[0] as any;
          if (userSession) {
            if (userSession.accessToken) variables["auth.accessToken"] = userSession.accessToken;
            if (userSession.refreshToken) variables["auth.refreshToken"] = userSession.refreshToken;
            if (userSession.cookies && userSession.cookies.length) {
              variables["auth.cookie"] = userSession.cookies.join("; ");
            }
            if (userSession.apiKey) variables["auth.apiKey"] = userSession.apiKey;
          }
        }

        // Run pre-run DB snapshot
        const affectedTables = getAffectedTables(plan, (run.contracts || []) as any[]);
        for (const table of affectedTables) {
          try {
            await assertionEngine.assertDBState({
              action: "snapshot",
              snapshotId: `${workflowRunId}-pre-${table}`,
              table
            });
          } catch (err: any) {
            logger.warn({ table, err: err.message }, "Failed to capture pre-run database snapshot");
          }
        }

        const interpolate = (val: any): any => {
          if (typeof val === "string") {
            const exact = val.match(/^\${([^}]+)}$/);
            if (exact) return variables[exact[1]] ?? val;
            return val.replace(/\${([^}]+)}/g, (match, name) => {
              const replacement = variables[name];
              return replacement === undefined ? match : String(replacement);
            });
          }
          if (Array.isArray(val)) return val.map(interpolate);
          if (val && typeof val === "object") {
            return Object.fromEntries(
              Object.entries(val).map(([k, v]) => [k, interpolate(v)])
            );
          }
          return val;
        };

        const extractVariables = (definitions: any, body: any) => {
          if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) return;
          for (const [name, candidatePaths] of Object.entries(definitions)) {
            const paths = Array.isArray(candidatePaths) ? candidatePaths : [candidatePaths];
            for (const p of paths) {
              if (typeof p !== "string") continue;
              if (!p.startsWith("$.")) continue;
              const segments = p.slice(2).split(".").filter(Boolean);
              let current = body;
              let found = true;
              for (const segment of segments) {
                if (!current || typeof current !== "object" || Array.isArray(current)) {
                  found = false;
                  break;
                }
                current = (current as any)[segment];
              }
              if (found && current !== undefined) {
                variables[name] = current;
                break;
              }
            }
          }
        };

        const stepResults: any[] = [];
        const stepIdToEventId = new Map<string, string>();

        for (const step of plan.steps) {
          const stepStart = Date.now();
          const configWithVars = interpolate(step.config || {});
          configWithVars.correlationId = correlationId;
          configWithVars.workflowRunId = workflowRunId;
          configWithVars.stepId = step.id;
          
          let stepSuccess = false;
          let stepLog = "";
          let stepError = "";
          let stepStatus: "COMPLETED" | "FAILED" | "UNSUPPORTED" = "FAILED";
          let responseBody: any = null;

          try {
            if (step.type === "HTTP_REQUEST" || step.type === "CREATE_USER" || step.type === "AUTHENTICATE") {
              const res = await drivers.executeHTTPStep(configWithVars as any);
              stepSuccess = res.success;
              stepLog = res.log;
              responseBody = res.body;
              if (!res.success) {
                stepError = `HTTP request failed with status ${res.status}`;
              } else {
                extractVariables(step.config.extractVariables, responseBody);
              }
            } else if (step.type === "BROWSER_ACTION") {
              const res = await drivers.executeBrowserStep(configWithVars as any);
              stepSuccess = res.success;
              stepLog = res.log;
              if (!res.success) stepError = "Browser execution failed";
            } else if (step.type === "WEBSOCKET_OPEN") {
              const res = await drivers.executeWebSocketStep(configWithVars as any);
              stepSuccess = res.success;
              stepLog = res.log;
              if (!res.success) stepError = "WebSocket execution failed";
            } else if (step.type === "SIMULATE_WEBHOOK") {
              const res = await drivers.executeWebhookStep(configWithVars as any);
              stepSuccess = res.success;
              stepLog = res.log;
              if (!res.success) stepError = "Webhook simulation failed";
            } else if (step.type === "WAIT_FOR_JOB") {
              const queueConfig = {
                queueName: configWithVars.queueName,
                jobId: configWithVars.jobId,
                event: configWithVars.event,
                state: configWithVars.state || "completed",
                payloadContains: configWithVars.payloadContains,
                minRetries: configWithVars.minRetries
              };
              const timeout = configWithVars.timeoutMs || 5000;
              const interval = 500;
              const start = Date.now();
              let lastRes: any = { success: false, log: "No attempt made" };
              while (Date.now() - start < timeout) {
                lastRes = await assertionEngine.assertQueueEvent(queueConfig);
                if (lastRes.success) {
                  break;
                }
                await this.sleep(interval);
              }
              stepSuccess = lastRes.success;
              stepLog = lastRes.log;
              if (!lastRes.success) {
                stepError = `Queue job assertion failed: ${lastRes.log}`;
              }
            } else {
              throw new UnsupportedWorkflowStepError(step.type);
            }
            stepStatus = stepSuccess ? "COMPLETED" : "FAILED";
          } catch (err: any) {
            stepSuccess = false;
            stepStatus = err instanceof UnsupportedWorkflowStepError ? "UNSUPPORTED" : "FAILED";
            stepLog = err instanceof UnsupportedWorkflowStepError
              ? err.message
              : `Step execution exception: ${err.message}`;
            stepError = err.message;
          }

          // Record step
          await correlationManager.recordStepRun(
            workflowRunId,
            step.id,
            stepStatus,
            [stepLog],
            stepError || undefined
          );

          await correlationManager.recordTraceEvent(workflowRunId, {
            timestamp: new Date().toISOString(),
            service: "api",
            component: "http",
            action: step.name,
            logs: [stepLog],
            error: stepError || undefined
          });

          const duration = Date.now() - stepStart;
          let protocol: "http" | "websocket" | "webhook" | "queue" | "browser" | "other" = "other";
          if (step.type === "HTTP_REQUEST" || step.type === "CREATE_USER" || step.type === "AUTHENTICATE") {
            protocol = "http";
          } else if (step.type === "BROWSER_ACTION") {
            protocol = "browser";
          } else if (step.type === "WEBSOCKET_OPEN") {
            protocol = "websocket";
          } else if (step.type === "SIMULATE_WEBHOOK") {
            protocol = "webhook";
          } else if (step.type === "WAIT_FOR_JOB") {
            protocol = "queue";
          }

          const dependsOn = step.config?.dependsOn || [];
          const parentId = dependsOn.length > 0 ? stepIdToEventId.get(dependsOn[0]) : undefined;
          const eventId = `evt_${crypto.randomUUID()}`;
          stepIdToEventId.set(step.id, eventId);

          const evidenceEvent: EvidenceEvent = {
            id: eventId,
            runId: this.id,
            workflowId: artifacts.workflowId || "unknown",
            correlationId,
            parentId,
            timestamp: new Date().toISOString(),
            service: "api",
            protocol,
            operation: step.name,
            timing: duration,
            success: stepSuccess,
            request: {
              action: configWithVars.action,
              url: configWithVars.url || configWithVars.endpointUrl,
              method: configWithVars.method,
              selector: configWithVars.selector,
              queueName: configWithVars.queueName,
              event: configWithVars.event
            },
            response: {
              status: stepSuccess ? "success" : "failed",
              error: stepError || undefined,
              logs: [stepLog]
            },
            artifacts: {}
          };

          await correlationManager.recordEvidenceEvent(this.id, evidenceEvent);

          stepResults.push({
            stepId: step.id,
            name: step.name,
            type: step.type,
            status: stepStatus,
            log: stepLog,
            error: stepError || null
          });

          // Dynamically persist step execution log
          await prisma.diagnosticRun.update({
            where: { id: this.id },
            data: { executedSteps: stepResults }
          });

          if (!stepSuccess) {
            overallSuccess = false;
            failedStepName = step.name;
            stepFailureReason = stepError || stepLog;
            break;
          }
        }

        // Run post assertions
        for (const table of affectedTables) {
          try {
            const dbAssertionStart = Date.now();
            const dbAssertion = await assertionEngine.assertDBState({
              action: "diff",
              snapshotId: `${workflowRunId}-pre-${table}`,
              table
            });
            const dbAssertionDuration = Date.now() - dbAssertionStart;

            await correlationManager.recordTraceEvent(workflowRunId, {
              timestamp: new Date().toISOString(),
              service: "database",
              component: "database",
              action: `Post-run Diff Assertion (${table})`,
              logs: [dbAssertion.log],
              error: dbAssertion.success ? undefined : `Database diff assertion failed for ${table}`
            });

            // Find parentId from the last executed step's event ID
            const lastStepResult = stepResults[stepResults.length - 1];
            const lastEventId = lastStepResult ? stepIdToEventId.get(lastStepResult.stepId) : undefined;

            await correlationManager.recordEvidenceEvent(this.id, {
              id: `evt_${crypto.randomUUID()}`,
              runId: this.id,
              workflowId: artifacts.workflowId || "unknown",
              correlationId,
              parentId: lastEventId,
              timestamp: new Date().toISOString(),
              service: "database",
              protocol: "database",
              operation: `Post-run Diff Assertion (${table})`,
              timing: dbAssertionDuration,
              success: dbAssertion.success,
              request: { action: "diff", table, snapshotId: `${workflowRunId}-pre-${table}` },
              response: { log: dbAssertion.log },
              artifacts: {}
            });

            if (!dbAssertion.success) {
              overallSuccess = false;
              if (!failedStepName) {
                failedStepName = `Post-run Database Assertion (${table})`;
                stepFailureReason = dbAssertion.log;
              }
            }
          } catch (err: any) {
            logger.warn({ table, err: err.message }, "Failed to run post-run database diff assertion");
          }
        }

        await correlationManager.completeWorkflowRun(workflowRunId, overallSuccess ? "COMPLETED" : "FAILED");

        if (overallSuccess) {
          // Clean up database records
          await runDatabaseCleanup(assertionEngine, affectedTables, variables);

          // All steps passed! Clean up sandbox and complete.
          await this.cleanupSandbox(sandboxId);
          const completedRun = await prisma.diagnosticRun.update({
            where: { id: this.id },
            data: {
              status: "COMPLETED",
              stage: "FINISHED",
              progress: 100,
              failureCode: null,
              failureMessage: null,
              retryable: false,
              completedAt: new Date()
            }
          });
          await this.recordUsageMetrics(completedRun);
        } else {
          // Step failed. Save failure details and proceed to localization.
          artifacts.failedStepName = failedStepName;
          artifacts.stepFailureReason = stepFailureReason;
          run = await prisma.diagnosticRun.update({
            where: { id: this.id },
            data: {
              artifacts: artifacts,
              stage: "LOCALIZING_FAILURE"
            },
            include: { repository: true }
          });
        }
      } catch (err: any) {
        await this.fail(err.message, "EXECUTING_WORKFLOW");
        return;
      }
    }

    if (await this.checkCancelled(sandboxId)) return;
    // ==========================================
    // Stage 9: LOCALIZING_FAILURE (Root-cause localization)
    // ==========================================
    if (run.stage === "LOCALIZING_FAILURE") {
      logger.info({ diagnosticRunId: this.id }, "Stage: LOCALIZING_FAILURE");
      try {
        const localizer = new FailureLocalizer(false);
        const boundaryId = await localizer.localizeFailure(
          workflowRunId,
          failedStepName || artifacts.failedStepName || "execution",
          stepFailureReason || artifacts.stepFailureReason || "Unknown failure",
          snapshotId || undefined
        );

        // Load root cause details if any
        const boundary = await prisma.failureBoundary.findUnique({
          where: { id: boundaryId }
        });
        const parsedReport = JSON.parse(boundary?.reason || "{}");
        const rootCause = parsedReport.finalRootCause || "Unknown failure";

        // Generate Remediation Plan and ChangeSet
        logger.info({ rootCause }, "Generating remediation plan");
        const { RemediationPlanManager, ChangeSetManager } = await import("@opspilot/remediation-engine");

        const planManager = new RemediationPlanManager(false);
        const changesetManager = new ChangeSetManager(false);

        const planInfo = await planManager.generatePlans(
          boundaryId,
          "Auto-remediation Fix",
          `Remediation plan for: ${rootCause}`,
          [{ action: "Apply code corrections", file: "src/queue.ts" }]
        );

        await changesetManager.createChangeSet(planInfo.planId, []);

        const loopRes = {
          success: false,
          attemptCount: 0,
          finalLogs: [
            "PATCH_PROPOSAL_REQUIRED: no validated unified-diff patch proposal was generated for this diagnosis."
          ]
        };

        logger.info({ loopRes }, "Remediation loop execution finished");

        await this.cleanupSandbox(sandboxId);

        const completedRun = await prisma.diagnosticRun.update({
          where: { id: this.id },
          data: {
            status: "FAILED",
            stage: "FINISHED",
            rootCause: rootCause,
            remediationStatus: loopRes.success ? "SUCCEEDED" : "PATCH_PROPOSAL_REQUIRED",
            failureCode: loopRes.success ? "APPLICATION_FAILURE_REPAIRED" : "PATCH_PROPOSAL_REQUIRED",
            failureMessage: rootCause,
            retryable: false,
            completedAt: new Date()
          }
        });
        await this.recordUsageMetrics(completedRun);
      } catch (err: any) {
        await this.cleanupSandbox(sandboxId);
        const completedRun = await prisma.diagnosticRun.update({
          where: { id: this.id },
          data: {
            status: "FAILED",
            stage: "FINISHED",
            rootCause: `Remediation / Localization failed: ${err.message}. Original failure: ${stepFailureReason || artifacts.stepFailureReason}`,
            failureCode: "LOCALIZATION_OR_REMEDIATION_FAILED",
            failureMessage: err.message,
            retryable: false,
            completedAt: new Date()
          }
        });
        await this.recordUsageMetrics(completedRun);
      }
    }
  }

  private assertNotAborted(): void {
    if (this.options.signal?.aborted) {
      throw new DiagnosticWorkerError(
        "DIAGNOSTIC_RUN_CANCELLED",
        "Diagnostic run was cancelled.",
        false
      );
    }
  }

  private async sleep(ms: number): Promise<void> {
    this.assertNotAborted();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, ms);
      const abort = () => {
        clearTimeout(timeout);
        reject(new DiagnosticWorkerError(
          "DIAGNOSTIC_RUN_CANCELLED",
          "Diagnostic run was cancelled.",
          false
        ));
      };

      if (this.options.signal?.aborted) {
        abort();
        return;
      }

      this.options.signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private async fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    this.assertNotAborted();
    return fetch(input, {
      ...init,
      signal: this.options.signal ?? init.signal
    });
  }

  private async fail(reason: string, failedStage: string): Promise<void> {
    logger.error({ diagnosticRunId: this.id, failedStage, reason }, "DiagnosticRun failed");
    
    // Clean up sandbox if any
    try {
      const run = await prisma.diagnosticRun.findUnique({ where: { id: this.id } });
      const artifacts = (run?.artifacts || {}) as any;
      if (artifacts.sandboxId) {
        await this.cleanupSandbox(artifacts.sandboxId);
      }
    } catch (cleanupErr) {
      logger.warn({ cleanupErr }, "Failed to clean up sandbox on fail");
    }

    const completedRun = await prisma.diagnosticRun.update({
      where: { id: this.id },
      data: {
        status: "FAILED",
        stage: "FINISHED",
        rootCause: `Failed in stage ${failedStage}: ${reason}`,
        failureCode: `STAGE_${failedStage}_FAILED`.replace(/[^A-Z0-9_]/g, "_"),
        failureMessage: reason,
        retryable: false,
        completedAt: new Date()
      }
    });
    await this.recordUsageMetrics(completedRun);
  }

  private async cleanupSandbox(sandboxId: string | undefined): Promise<void> {
    if (!sandboxId) return;
    logger.info({ sandboxId }, "Cleaning up sandbox");
    try {
      const res = await fetch(`${config.services.sandboxControllerUrl}/api/sandboxes/${sandboxId}`, {
        method: "DELETE"
      });
      if (!res.ok) {
        logger.error({ sandboxId, status: res.statusText }, "Failed to clean up sandbox container");
      }
    } catch (err) {
      logger.error({ err, sandboxId }, "Exception cleaning up sandbox container");
    }
  }

  private async checkCancelled(sandboxId?: string): Promise<boolean> {
    if (this.options.signal?.aborted) {
      logger.info({ diagnosticRunId: this.id }, "DiagnosticRun cancellation signal detected. Cleaning up resources.");
      if (sandboxId) {
        await this.cleanupSandbox(sandboxId);
      }
      await prisma.diagnosticRun.update({
        where: { id: this.id },
        data: {
          status: "CANCELLED",
          failureCode: "CANCELLED_BY_USER",
          failureMessage: "Diagnostic run was cancelled while the worker was running.",
          retryable: false,
          completedAt: new Date()
        }
      }).catch((err) => {
        logger.warn({ err, diagnosticRunId: this.id }, "Failed to persist signal cancellation state");
      });
      return true;
    }

    const current = await prisma.diagnosticRun.findUnique({
      where: { id: this.id },
      select: { status: true, artifacts: true }
    });
    if (current?.status === "CANCELLED") {
      logger.info({ diagnosticRunId: this.id }, "DiagnosticRun cancellation detected midway. Cleaning up resources.");
      const currentSandboxId = sandboxId || (current.artifacts as any)?.sandboxId;
      if (currentSandboxId) {
        await this.cleanupSandbox(currentSandboxId);
      }
      const completedRun = {
        ...current,
        id: this.id,
        repositoryId: (await prisma.diagnosticRun.findUnique({ where: { id: this.id }, select: { repositoryId: true } }))?.repositoryId
      };
      await this.recordUsageMetrics(completedRun);
      return true;
    }
    return false;
  }

  private async recordUsageMetrics(completedRun: any): Promise<void> {
    try {
      const artifacts = (completedRun.artifacts || {}) as any;
      const sandboxStartedAtStr = artifacts.sandboxStartedAt;
      if (sandboxStartedAtStr) {
        const sandboxStartedAt = new Date(sandboxStartedAtStr);
        const completedAt = completedRun.completedAt || new Date();
        const durationMs = completedAt.getTime() - sandboxStartedAt.getTime();
        const minutes = Math.ceil(durationMs / 60000);

        const repo = await prisma.repository.findUnique({
          where: { id: completedRun.repositoryId },
          include: { project: true }
        });
        const orgId = repo?.project.organizationId || "default-org";

        await prisma.usageRecord.create({
          data: {
            orgId,
            dimension: "sandbox_minutes",
            quantity: minutes,
            timestamp: new Date()
          }
        });
        logger.info({ diagnosticRunId: this.id, minutes, orgId }, "Recorded sandbox usage metrics");
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, "Failed to record sandbox usage metrics");
    }
  }
}
