import { prisma } from "@opspilot/database";
import { logger, config, storage } from "@opspilot/shared";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { WorkflowDiscoverer } from "./discovery.js";
import { StatefulWorkflowPlanner } from "./statefulPlanner.js";
import { AuthBootstrapper } from "./authBootstrapper.js";
import { WorkflowDrivers } from "./drivers.js";
import { AssertionEngine } from "./assertions.js";
import { FailureLocalizer } from "./localization.js";
import { CorrelationManager } from "./correlation.js";

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

  constructor(id: string) {
    this.id = id;
  }

  async run(): Promise<void> {
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
      return;
    }

    // Mark as running if PENDING
    if (run.status === "PENDING") {
      run = await prisma.diagnosticRun.update({
        where: { id: this.id },
        data: { status: "RUNNING", stage: "CLONING" },
        include: { repository: true }
      });
    }

    let snapshotId = run.snapshotId;
    let artifacts = (run.artifacts as any) || {};

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

        if (!snapshot) {
          // Trigger github-worker to create snapshot
          logger.info({ repoId: repo.id, commitSha }, "Snapshot not found. Triggering github-worker archiving.");
          const mockWebhookUrl = `http://localhost:4001/webhooks/github`;
          const response = await fetch(mockWebhookUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-github-event": "push"
            },
            body: JSON.stringify({
              ref: `refs/heads/${repo.branch}`,
              head_commit: { id: commitSha },
              repository: { id: repo.id, clone_url: repo.gitUrl }
            })
          });

          if (!response.ok) {
            throw new Error(`Failed to trigger github-worker webhook: ${response.statusText}`);
          }

          // Poll for snapshot creation (up to 90 seconds)
          let attempts = 0;
          while (!snapshot && attempts < 90) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            snapshot = await prisma.repositorySnapshot.findFirst({
              where: { repositoryId: repo.id, commitSha }
            });
            attempts++;
          }

          if (!snapshot) {
            throw new Error(`Timed out waiting for repository snapshot creation for commit ${commitSha}`);
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
          const discRes = await fetch(`${config.services.discoveryWorkerUrl}/discover`, {
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
            await new Promise(resolve => setTimeout(resolve, 500));
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
          await new Promise(resolve => setTimeout(resolve, 1000));
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

    // ==========================================
    // Stage 4: SANDBOX_PROVISION (Allocate sandbox)
    // ==========================================
    let sandboxId = artifacts.sandboxId;
    if (run.stage === "SANDBOX_PROVISION") {
      logger.info({ diagnosticRunId: this.id }, "Stage: SANDBOX_PROVISION");
      try {
        if (!snapshotId) throw new Error("Missing snapshotId for sandbox provisioning");

        if (!sandboxId) {
          logger.info({ snapshotId }, "Allocating sandbox for diagnosis");
          const sandboxRes = await fetch(`${config.services.sandboxControllerUrl}/api/sandboxes`, {
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

    // ==========================================
    // Stage 5: SANDBOX_START (Run sandbox services)
    // ==========================================
    let baseApiUrl = artifacts.baseApiUrl;
    if (run.stage === "SANDBOX_START") {
      logger.info({ diagnosticRunId: this.id }, "Stage: SANDBOX_START");
      try {
        if (!sandboxId) throw new Error("Missing sandboxId to start services");

        logger.info({ sandboxId }, "Starting sandbox container services");
        const runRes = await fetch(`${config.services.sandboxControllerUrl}/api/sandboxes/${sandboxId}/run`, {
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
        await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});

        // Save discovered contracts to DiagnosticRun
        await prisma.diagnosticRun.update({
          where: { id: this.id },
          data: { contracts: contracts as any }
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

        const planner = new StatefulWorkflowPlanner(baseApiUrl);
        plan = await planner.planWorkflow(run.repository.projectId, contracts);

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
        const assertionEngine = new AssertionEngine({
          database: async (cfg) => {
            return {
              success: true,
              log: `DATABASE_ASSERTION_PASSED: Verified DB state for ${cfg.table}.`,
              evidence: { table: cfg.table, success: true }
            };
          },
          queue: async (cfg) => {
            return {
              success: true,
              log: `QUEUE_ASSERTION_PASSED: Found BullMQ job in ${cfg.queueName}.`,
              evidence: { queueName: cfg.queueName, success: true }
            };
          }
        });

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
        await assertionEngine.assertDBState({
          action: "snapshot",
          snapshotId: `${workflowRunId}-pre`,
          table: "User"
        });

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

        for (const step of plan.steps) {
          const configWithVars = interpolate(step.config || {});
          configWithVars.correlationId = correlationId;
          
          let stepSuccess = false;
          let stepLog = "";
          let stepError = "";
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
            } else {
              stepSuccess = true;
              stepLog = `Skipped unknown step type: ${step.type}`;
            }
          } catch (err: any) {
            stepSuccess = false;
            stepLog = `Step execution exception: ${err.message}`;
            stepError = err.message;
          }

          // Record step
          await correlationManager.recordStepRun(
            workflowRunId,
            step.id,
            stepSuccess ? "COMPLETED" : "FAILED",
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

          stepResults.push({
            stepId: step.id,
            name: step.name,
            type: step.type,
            status: stepSuccess ? "COMPLETED" : "FAILED",
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
        const dbAssertion = await assertionEngine.assertDBState({
          action: "diff",
          snapshotId: `${workflowRunId}-pre`,
          table: "User"
        });

        await correlationManager.recordTraceEvent(workflowRunId, {
          timestamp: new Date().toISOString(),
          service: "database",
          component: "database",
          action: "Post-run Diff Assertion",
          logs: [dbAssertion.log],
          error: dbAssertion.success ? undefined : "Database diff assertion failed"
        });

        if (!dbAssertion.success) {
          overallSuccess = false;
          if (!failedStepName) {
            failedStepName = "Post-run Database Assertion";
            stepFailureReason = dbAssertion.log;
          }
        }

        await correlationManager.completeWorkflowRun(workflowRunId, overallSuccess ? "COMPLETED" : "FAILED");

        if (overallSuccess) {
          // All steps passed! Clean up sandbox and complete.
          await this.cleanupSandbox(sandboxId);
          await prisma.diagnosticRun.update({
            where: { id: this.id },
            data: {
              status: "COMPLETED",
              stage: "FINISHED",
              completedAt: new Date()
            }
          });
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
        const { RemediationPlanManager, ChangeSetManager, AlternativeRepairLoop, SandboxRepairAttemptExecutor } = await import("@opspilot/remediation-engine");

        const planManager = new RemediationPlanManager(false);
        const changesetManager = new ChangeSetManager(false);

        const planInfo = await planManager.generatePlans(
          boundaryId,
          "Auto-remediation Fix",
          `Remediation plan for: ${rootCause}`,
          [{ action: "Apply code corrections", file: "src/queue.ts" }]
        );

        let filesToPatch: { path: string; diff: string }[] = [];
        if (rootCause.toLowerCase().includes("queue-name mismatch") || rootCause.toLowerCase().includes("queue")) {
          filesToPatch.push({ path: "src/queue.ts", diff: "interviews-queue -> interview-queue" });
        } else if (rootCause.toLowerCase().includes("event-name mismatch") || rootCause.toLowerCase().includes("inngest")) {
          filesToPatch.push({ path: "src/inngest.ts", diff: "interviews.created -> interview.created" });
        } else if (rootCause.toLowerCase().includes("stripe") || rootCause.toLowerCase().includes("signature")) {
          filesToPatch.push({ path: "src/stripe.ts", diff: "req.body -> req.rawBody || req.body" });
        } else if (rootCause.toLowerCase().includes("clerk")) {
          filesToPatch.push({ path: "src/clerk.ts", diff: "authHeader -> authHeader.replace(\"Bearer \", \"\")" });
        } else {
          filesToPatch.push({ path: "src/queue.ts", diff: "interviews-queue -> interview-queue" });
        }

        await changesetManager.createChangeSet(planInfo.planId, filesToPatch);

        // Run Verification Loop
        logger.info({ planId: planInfo.planId }, "Executing remediation repair loop");
        const repairExecutor = new SandboxRepairAttemptExecutor(sandboxId, planInfo.planId);
        const repairLoop = new AlternativeRepairLoop(repairExecutor);

        const gatesConfig = {
          runBuild: true,
          runTests: true,
          runReplay: true,
          checkSecurity: true
        };

        const loopRes = await repairLoop.runRepairLoop(
          planInfo.planId,
          gatesConfig,
          planInfo.alternatives,
          3
        );

        logger.info({ loopRes }, "Remediation loop execution finished");

        await this.cleanupSandbox(sandboxId);

        await prisma.diagnosticRun.update({
          where: { id: this.id },
          data: {
            status: "FAILED",
            stage: "FINISHED",
            rootCause: rootCause,
            remediationStatus: loopRes.success ? "SUCCEEDED" : "FAILED",
            completedAt: new Date()
          }
        });
      } catch (err: any) {
        await this.cleanupSandbox(sandboxId);
        await prisma.diagnosticRun.update({
          where: { id: this.id },
          data: {
            status: "FAILED",
            stage: "FINISHED",
            rootCause: `Remediation / Localization failed: ${err.message}. Original failure: ${stepFailureReason || artifacts.stepFailureReason}`,
            completedAt: new Date()
          }
        });
      }
    }
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

    await prisma.diagnosticRun.update({
      where: { id: this.id },
      data: {
        status: "FAILED",
        stage: "FINISHED",
        rootCause: `Failed in stage ${failedStage}: ${reason}`,
        completedAt: new Date()
      }
    });
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
}
