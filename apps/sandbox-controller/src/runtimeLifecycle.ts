import crypto from "node:crypto";
import { ContainerRunner } from "./containerRunner.js";
import { BuildRunner, BuildResult } from "./buildRunner.js";
import { DependencyResolver } from "./dependencyResolver.js";
import { DependencyProvisionResult, DependencyServiceManager } from "./dependencyServices.js";
import { SandboxManager } from "./sandbox.js";
import { ServiceStartupManager } from "./serviceStartup.js";
import { TestRunner } from "./testRunner.js";

type TestType = "unit" | "integration" | "e2e";

export interface LifecycleStageResult {
  stage: string;
  success: boolean;
  log: string;
  exitCode?: number | null;
  durationMs?: number;
}

export interface RuntimeLifecycleResult {
  success: boolean;
  sandboxId: string;
  status: string;
  network: string;
  environmentNames: string[];
  endpoints: Array<{
    serviceId: string;
    serviceName: string;
    kind: "frontend" | "api" | "worker" | "application";
    containerPort: number;
    hostPort: number;
    internalUrl: string;
    externalUrl: string;
  }>;
  services: Array<{
    serviceId: string;
    serviceName: string;
    kind: "frontend" | "api" | "worker" | "application";
    success: boolean;
    containerId?: string;
    attempts: number;
    log: string;
  }>;
  logs: Record<string, string>;
  stages: LifecycleStageResult[];
  tests: Array<{
    id: string;
    serviceId?: string;
    type: TestType;
    success: boolean;
    log: string;
    exitCode: number | null;
  }>;
}

export class RuntimeLifecycleError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly result?: Partial<RuntimeLifecycleResult>
  ) {
    super(message);
    this.name = "RuntimeLifecycleError";
  }
}

export class RuntimeLifecycleManager {
  private readonly networks = new Map<string, string>();

  constructor(
    private readonly sandboxManager: SandboxManager,
    private readonly dependencyResolver: DependencyResolver,
    private readonly buildRunner: BuildRunner,
    private readonly dependencyServices: DependencyServiceManager,
    private readonly serviceStartup: ServiceStartupManager,
    private readonly testRunner: TestRunner,
    private readonly runner = new ContainerRunner(),
    private readonly httpProbe?: (url: string) => Promise<{ status: number; body: string }>
  ) {}

  public async run(
    sandboxId: string,
    suppliedEnvironment: Record<string, string> = {}
  ): Promise<RuntimeLifecycleResult> {
    const manifest = this.sandboxManager.getWorkspaceManifest(sandboxId);
    if (!manifest.execution.supported) {
      throw new RuntimeLifecycleError(
        "UNSUPPORTED_EXECUTION_MANIFEST",
        manifest.execution.issues.join(" ") || "The repository does not have a supported execution manifest."
      );
    }
    const applications = manifest.execution.startCommands;
    if (applications.length === 0) {
      throw new RuntimeLifecycleError("START_COMMAND_NOT_CONFIGURED", "No application start command was discovered.");
    }

    await this.cleanupRuntime(sandboxId);
    const network = await this.runner.createNetwork(sandboxId);
    this.networks.set(sandboxId, network);
    const stages: LifecycleStageResult[] = [];

    try {
      await this.sandboxManager.updateStatus(sandboxId, "PROVISIONING_DEPENDENCIES");
      const dependencies = await this.dependencyServices.provision(
        sandboxId,
        network,
        manifest.execution.services
      );
      stages.push(this.dependencyStage(dependencies));
      if (!dependencies.success) {
        return await this.fail(sandboxId, network, "DEPENDENCY_PROVISION_FAILED", stages);
      }

      const environment = this.buildEnvironment(
        manifest.execution.requiredEnvironment
          .filter((item) => item.required)
          .map((item) => item.name),
        dependencies.environment,
        suppliedEnvironment
      );

      await this.sandboxManager.updateStatus(sandboxId, "INSTALLING_DEPENDENCIES");
      const install = await this.dependencyResolver.resolve(
        manifest.repositoryRoot,
        sandboxId,
        manifest.execution,
        network
      );
      stages.push({ stage: "install", ...install });
      if (!install.success) {
        return await this.fail(sandboxId, network, "DEPENDENCY_INSTALL_FAILED", stages);
      }
      await this.sandboxManager.updateStatus(sandboxId, "DEPENDENCIES_INSTALLED");

      await this.sandboxManager.updateStatus(sandboxId, "BUILDING_APPLICATION");
      const build = await this.buildRunner.build(
        sandboxId,
        manifest.repositoryRoot,
        manifest.execution,
        network,
        environment
      );
      stages.push(this.buildStage(build));
      if (!build.success) {
        return await this.fail(sandboxId, network, "BUILD_FAILED", stages);
      }
      await this.sandboxManager.updateStatus(sandboxId, "BUILD_SUCCEEDED");

      const migrationCommands = manifest.execution.migrationCommands?.length
        ? manifest.execution.migrationCommands
        : manifest.execution.migrationCommand
          ? [{ id: "migrate:root", command: manifest.execution.migrationCommand, workingDirectory: "." }]
          : [];
      if (migrationCommands.length > 0) {
        await this.sandboxManager.updateStatus(sandboxId, "RUNNING_MIGRATIONS");
        for (const migrationCommand of migrationCommands) {
          const migration = await this.runner.run({
            sandboxId,
            workspaceDir: manifest.repositoryRoot,
            workingDirectory: migrationCommand.workingDirectory,
            command: migrationCommand.command,
            network,
            environment
          });
          stages.push({ stage: migrationCommand.id, ...migration });
          if (!migration.success) {
            return await this.fail(sandboxId, network, "MIGRATION_FAILED", stages);
          }
        }
      } else {
        stages.push({ stage: "migrations", success: true, log: "MIGRATION_COMMAND_NOT_CONFIGURED: Stage skipped." });
      }

      await this.sandboxManager.updateStatus(sandboxId, "STARTING_SERVICES");
      const started = await this.serviceStartup.startServices(
        sandboxId,
        manifest.repositoryRoot,
        applications,
        environment,
        network,
        manifest.execution.healthChecks
      );
      for (const service of started.services) {
        stages.push({
          stage: `start:${service.serviceId}`,
          success: service.success,
          log: service.log
        });
      }
      if (!started.success) {
        return await this.fail(sandboxId, network, "SERVICE_STARTUP_FAILED", stages);
      }
      await this.sandboxManager.updateStatus(sandboxId, "SERVICES_RUNNING");

      for (const healthCheck of manifest.execution.healthChecks) {
        if (healthCheck.type !== "http") continue;
        const endpoint = started.endpoints.find(
          (candidate) =>
            candidate.serviceId === healthCheck.serviceId &&
            candidate.containerPort === healthCheck.port
        );
        if (!endpoint) {
          stages.push({
            stage: `workflow:http-health:${healthCheck.serviceId}`,
            success: false,
            log: `APPLICATION_ENDPOINT_NOT_AVAILABLE: ${healthCheck.serviceId}`
          });
          return await this.fail(sandboxId, network, "APPLICATION_ENDPOINT_NOT_AVAILABLE", stages);
        }
        const workflowProbe = await this.runHttpProbe(
          endpoint.externalUrl,
          healthCheck.path || "/",
          healthCheck.serviceId
        );
        stages.push(workflowProbe);
        if (!workflowProbe.success) {
          return await this.fail(sandboxId, network, "WORKFLOW_REPLAY_FAILED", stages);
        }
      }

      const tests: RuntimeLifecycleResult["tests"] = [];
      for (const command of manifest.execution.testCommands) {
        await this.sandboxManager.updateStatus(sandboxId, `RUNNING_${command.type.toUpperCase()}_TESTS`);
        const target = this.serviceStartup.getActiveServices(sandboxId)
          .find((candidate) => candidate.service.id === command.serviceId) ||
          this.serviceStartup.getActiveServices(sandboxId)
            .find((candidate) => candidate.service.kind === "api") ||
          this.serviceStartup.getActiveServices(sandboxId)[0];
        const canExecInService = target && !target.service.build;
        const test = await this.testRunner.runTestCommand(
          sandboxId,
          manifest.repositoryRoot,
          command,
          network,
          started.environment,
          canExecInService ? target.containerId : undefined
        );
        tests.push({ id: command.id, serviceId: command.serviceId, type: command.type, ...test });
        stages.push({ stage: command.id, ...test });
      }

      if (tests.length === 0) {
        stages.push({
          stage: "test_discovery",
          success: false,
          log: "TEST_COMMAND_NOT_CONFIGURED: The application is healthy, but no test suite was discovered."
        });
      }
      const success = tests.length > 0 && tests.every((test) => test.success);
      const status = success
        ? "RUNTIME_VERIFIED"
        : tests.length === 0
          ? "RUNTIME_RUNNING_UNVERIFIED"
          : "TESTS_FAILED";
      await this.sandboxManager.updateStatus(sandboxId, status);
      const logs = await this.serviceStartup.collectLogs(sandboxId);
      return {
        success,
        sandboxId,
        status,
        network,
        environmentNames: Object.keys(started.environment).sort(),
        endpoints: started.endpoints,
        services: started.services.map((service) => ({
          serviceId: service.serviceId,
          serviceName: service.serviceName,
          kind: service.kind,
          success: service.success,
          containerId: service.containerId,
          attempts: service.attempts,
          log: service.log
        })),
        logs,
        stages,
        tests
      };
    } catch (error) {
      await this.cleanupRuntime(sandboxId);
      await this.sandboxManager.updateStatus(sandboxId, "RUNTIME_EXECUTION_FAILED").catch(() => undefined);
      if (error instanceof RuntimeLifecycleError) throw error;
      throw new RuntimeLifecycleError(
        "RUNTIME_EXECUTION_FAILED",
        error instanceof Error ? error.message : String(error),
        { sandboxId, stages }
      );
    }
  }

  public async cleanupRuntime(sandboxId: string): Promise<void> {
    await Promise.allSettled([
      this.serviceStartup.stopAll(sandboxId),
      this.dependencyServices.stopAll(sandboxId)
    ]);
    const network = this.networks.get(sandboxId);
    if (network) {
      await this.runner.removeNetwork(network).catch(() => undefined);
      this.networks.delete(sandboxId);
    }
    await this.runner.cleanupSandboxResources(sandboxId).catch(() => undefined);
  }

  private buildEnvironment(
    requiredNames: string[],
    generated: Record<string, string>,
    supplied: Record<string, string>
  ): Record<string, string> {
    const serviceGeneratedNames = new Set([
      "PORT",
      "HOST",
      "HOSTNAME",
      "BASE_URL",
      "APP_URL",
      "API_URL",
      "BACKEND_URL",
      "NEXT_PUBLIC_API_URL",
      "FRONTEND_URL"
    ]);
    requiredNames = [...new Set(requiredNames)].filter(
      (name) => !serviceGeneratedNames.has(name) && !name.startsWith("OPSPILOT_SERVICE_")
    );
    const allowedNames = new Set(requiredNames);
    const protectedNames = new Set([
      ...Object.keys(generated),
      "NODE_ENV",
      "HOST",
      "HOSTNAME",
      "BASE_URL",
      "APP_URL"
    ]);
    const acceptedEnvironment = Object.fromEntries(
      Object.entries(supplied).filter(
        ([name]) => allowedNames.has(name) && !protectedNames.has(name)
      )
    );
    const environment: Record<string, string> = {
      NODE_ENV: "test",
      ...acceptedEnvironment,
      ...generated,
      HOST: "0.0.0.0",
      HOSTNAME: "0.0.0.0"
    };
    for (const name of requiredNames) {
      if (!environment[name] && /(?:SECRET|SIGNING_KEY)$/i.test(name)) {
        environment[name] = crypto.randomBytes(32).toString("base64url");
      }
    }

    const missing = requiredNames.filter((name) => !environment[name]);
    if (missing.length > 0) {
      throw new RuntimeLifecycleError(
        "MISSING_REQUIRED_ENVIRONMENT",
        `Missing required sandbox environment variables: ${missing.join(", ")}`
      );
    }
    return environment;
  }

  private async runHttpProbe(
    baseUrl: string,
    requestPath: string,
    serviceId: string
  ): Promise<LifecycleStageResult> {
    const url = new URL(requestPath, `${baseUrl}/`).toString();
    const startedAt = Date.now();
    try {
      const response = this.httpProbe
        ? await this.httpProbe(url)
        : await fetch(url, { signal: AbortSignal.timeout(5_000) }).then(async (result) => ({
            status: result.status,
            body: await result.text()
          }));
      const body = response.body.slice(0, 2_048);
      return {
        stage: `workflow:http-health:${serviceId}`,
        success: response.status < 500,
        durationMs: Date.now() - startedAt,
        log: `GET ${url} -> ${response.status}${body ? `\n${body}` : ""}`
      };
    } catch (error) {
      return {
        stage: `workflow:http-health:${serviceId}`,
        success: false,
        durationMs: Date.now() - startedAt,
        log: `GET ${url} failed: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  private async fail(
    sandboxId: string,
    network: string,
    status: string,
    stages: LifecycleStageResult[]
  ): Promise<RuntimeLifecycleResult> {
    await this.sandboxManager.updateStatus(sandboxId, status);
    const logs = await this.serviceStartup.collectLogs(sandboxId);
    const services = this.serviceStartup.getActiveServices(sandboxId).map((active) => ({
      serviceId: active.service.id,
      serviceName: active.service.name,
      kind: active.service.kind,
      success: true,
      containerId: active.containerId,
      attempts: 1,
      log: logs[active.service.id] || ""
    }));
    await this.cleanupRuntime(sandboxId);
    return {
      success: false,
      sandboxId,
      status,
      network,
      environmentNames: [],
      endpoints: [],
      services,
      logs,
      stages,
      tests: []
    };
  }

  private dependencyStage(result: DependencyProvisionResult): LifecycleStageResult {
    return { stage: "provision_dependencies", success: result.success, log: result.log };
  }

  private buildStage(result: BuildResult): LifecycleStageResult {
    return {
      stage: "build",
      success: result.success,
      log: result.log,
      exitCode: result.exitCode,
      durationMs: result.durationMs
    };
  }
}
