import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export type PackageManager = "npm" | "pnpm" | "yarn";
export type ServiceKind = "frontend" | "api" | "worker" | "application";
export type ServiceSource = "root" | "workspace" | "nested-package" | "compose";

export interface ExecutionCommand {
  id: string;
  command: string[];
  workingDirectory: string;
  serviceId?: string;
}

export interface TestCommand extends ExecutionCommand {
  type: "unit" | "integration" | "e2e";
}

export interface ServiceBuild {
  context: string;
  dockerfile?: string;
}

export interface ServiceCommand {
  id: string;
  name: string;
  kind: ServiceKind;
  source: ServiceSource;
  command: string[];
  workingDirectory: string;
  packageDirectory?: string;
  packageName?: string;
  port?: number;
  dependsOn: string[];
  environment: Record<string, string>;
  image?: string;
  build?: ServiceBuild;
  restartAttempts: number;
  evidence: string[];
}

export interface DependencyService {
  type: "postgresql" | "redis" | "mongodb";
  required: boolean;
  evidence: string[];
}

export interface HealthCheck {
  serviceId: string;
  type: "http" | "tcp" | "process";
  port?: number;
  path?: string;
  startupTimeoutMs: number;
}

export interface EnvironmentRequirement {
  name: string;
  required: boolean;
  source: string;
  serviceId?: string;
}

export interface ExecutionManifest {
  version: 2;
  supported: boolean;
  repositoryKind: "single-package" | "workspace" | "compose" | "hybrid";
  packageManager: PackageManager;
  workspacePatterns: string[];
  composeFiles: string[];
  installCommand: string[];
  installCommands: ExecutionCommand[];
  buildCommand?: string[];
  buildCommands: ExecutionCommand[];
  migrationCommand?: string[];
  migrationCommands: ExecutionCommand[];
  testCommands: TestCommand[];
  startCommands: ServiceCommand[];
  startupOrder: string[];
  services: DependencyService[];
  ports: number[];
  healthChecks: HealthCheck[];
  requiredEnvironment: EnvironmentRequirement[];
  issues: string[];
}

interface PackageJson {
  name?: string;
  packageManager?: string;
  workspaces?: string[] | { packages?: string[] };
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PackageDescriptor {
  packageJson: PackageJson;
  relativeDirectory: string;
  absoluteDirectory: string;
  source: Exclude<ServiceSource, "compose">;
  packageManager: PackageManager;
  isWorkspace: boolean;
}

interface ComposeService {
  name: string;
  command: string[];
  workingDirectory: string;
  port?: number;
  dependsOn: string[];
  environment: Record<string, string>;
  image?: string;
  build?: ServiceBuild;
  healthCheck?: Omit<HealthCheck, "serviceId">;
  evidence: string[];
}

interface ComposeServiceDefinition {
  image?: string;
  build?: string | { context?: string; dockerfile?: string };
  command?: string | string[];
  working_dir?: string;
  volumes?: Array<string | { type?: string; source?: string; target?: string }>;
  ports?: Array<string | number | { target?: number; published?: number }>;
  environment?: Record<string, unknown> | string[];
  depends_on?: string[] | Record<string, unknown>;
  healthcheck?: {
    test?: string | string[];
    timeout?: string;
    interval?: string;
    retries?: number;
    start_period?: string;
  };
}

interface ComposeDocument {
  services?: Record<string, ComposeServiceDefinition>;
}

const COMPOSE_FILENAMES = [
  "compose.yml",
  "compose.yaml",
  "docker-compose.yml",
  "docker-compose.yaml"
];
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "sandbox"
]);

export async function discoverExecutionManifest(repositoryRoot: string): Promise<ExecutionManifest> {
  const root = path.resolve(repositoryRoot);
  const issues: string[] = [];
  const rootPackage = await readPackageJson(path.join(root, "package.json"), issues);
  const workspacePatterns = await discoverWorkspacePatterns(root, rootPackage, issues);
  const packageFiles = await findPackageJsonFiles(root);
  const packages = await describePackages(root, packageFiles, rootPackage, workspacePatterns, issues);
  const packageManager = detectRepositoryPackageManager(root, rootPackage, packages);
  const composeFiles = COMPOSE_FILENAMES
    .filter((name) => fs.existsSync(path.join(root, name)));

  if (packages.length === 0 && composeFiles.length === 0) {
    issues.push("UNSUPPORTED_STACK: No Node.js package or Docker Compose application was found.");
  }

  const serviceCandidates: ServiceCommand[] = [];
  for (const descriptor of packages) {
    const service = await packageService(descriptor);
    if (service) serviceCandidates.push(service);
  }

  const composeApplicationServices: ComposeService[] = [];
  const dependencyEvidence = new Map<DependencyService["type"], Set<string>>();
  for (const descriptor of packages) {
    const dependencies = combinedDependencies(descriptor.packageJson);
    addDependencyEvidence(dependencyEvidence, "postgresql", dependencies, [
      "pg", "postgres", "postgresql", "@prisma/client", "prisma"
    ], descriptor.relativeDirectory);
    addDependencyEvidence(dependencyEvidence, "redis", dependencies, [
      "redis", "ioredis", "bull", "bullmq"
    ], descriptor.relativeDirectory);
    addDependencyEvidence(dependencyEvidence, "mongodb", dependencies, [
      "mongodb", "mongoose"
    ], descriptor.relativeDirectory);
  }

  for (const composeFile of composeFiles) {
    const compose = await discoverComposeServices(root, composeFile, issues);
    for (const service of compose) {
      const dependencyType = dependencyTypeForComposeService(service);
      if (dependencyType) {
        const evidence = dependencyEvidence.get(dependencyType) || new Set<string>();
        service.evidence.forEach((item) => evidence.add(item));
        dependencyEvidence.set(dependencyType, evidence);
      } else {
        composeApplicationServices.push(service);
      }
    }
  }

  const startCommands = mergeComposeServices(serviceCandidates, composeApplicationServices);
  const startupOrder = orderServices(startCommands, issues);
  startCommands.sort((a, b) => startupOrder.indexOf(a.id) - startupOrder.indexOf(b.id));

  const services = [...dependencyEvidence.entries()].map(([type, evidence]) => ({
    type,
    required: true,
    evidence: [...evidence].sort()
  }));
  const installCommands = discoverInstallCommands(root, packages, packageManager, issues);
  const buildCommands = discoverLifecycleCommands(packages, "build");
  const migrationCommands = discoverMigrationCommands(packages);
  const testCommands = discoverTestCommands(packages);
  const healthChecks = startCommands.map((service): HealthCheck => {
    const composeHealth = composeApplicationServices
      .find((candidate) => candidate.evidence.some((item) => service.evidence.includes(item)))?.healthCheck;
    if (composeHealth) return { serviceId: service.id, ...composeHealth };
    if (service.port) {
      return {
        serviceId: service.id,
        type: service.kind === "worker" ? "tcp" : "http",
        port: service.port,
        path: service.kind === "worker" ? undefined : "/",
        startupTimeoutMs: service.kind === "frontend" ? 90_000 : 45_000
      };
    }
    return {
      serviceId: service.id,
      type: "process",
      startupTimeoutMs: 5_000
    };
  });
  const requiredEnvironment = await discoverEnvironmentRequirements(root, startCommands);

  if (installCommands.length === 0 && packages.length > 0) {
    issues.push("LOCKFILE_REQUIRED: Deterministic dependency installation requires a package lockfile.");
  }
  if (testCommands.length === 0) {
    issues.push("TEST_COMMAND_NOT_CONFIGURED: No supported test script was discovered.");
  }
  if (startCommands.length === 0) {
    issues.push("START_COMMAND_NOT_CONFIGURED: No runnable root, workspace, nested, or Compose service was discovered.");
  }

  const hasWorkspace = workspacePatterns.length > 0 || startCommands.some((service) => service.source === "workspace");
  const hasCompose = composeFiles.length > 0;
  const repositoryKind = hasCompose && (hasWorkspace || packages.length > 0)
    ? "hybrid"
    : hasCompose
      ? "compose"
      : hasWorkspace
        ? "workspace"
        : "single-package";
  const installCommand = installCommands[0]?.command || [];
  const buildCommand = buildCommands[0]?.command;
  const migrationCommand = migrationCommands[0]?.command;

  return {
    version: 2,
    supported:
      startCommands.length > 0 &&
      (packages.length === 0 || installCommands.length > 0) &&
      healthChecks.length === startCommands.length,
    repositoryKind,
    packageManager,
    workspacePatterns,
    composeFiles,
    installCommand,
    installCommands,
    buildCommand,
    buildCommands,
    migrationCommand,
    migrationCommands,
    testCommands,
    startCommands,
    startupOrder,
    services,
    ports: startCommands.flatMap((service) => service.port ? [service.port] : []),
    healthChecks,
    requiredEnvironment,
    issues
  };
}

export function normalizeExecutionManifest(manifest: ExecutionManifest): ExecutionManifest {
  const legacy = manifest as ExecutionManifest & {
    version?: number;
    installCommands?: ExecutionCommand[];
    buildCommands?: ExecutionCommand[];
    migrationCommands?: ExecutionCommand[];
    startupOrder?: string[];
    workspacePatterns?: string[];
    composeFiles?: string[];
    repositoryKind?: ExecutionManifest["repositoryKind"];
  };
  const issues = [...(legacy.issues || [])];
  const startCommands = (legacy.startCommands || []).map((service, index): ServiceCommand => {
    const candidate = service as Partial<ServiceCommand>;
    return {
      ...service,
      id: candidate.id || `application-${index + 1}`,
      name: candidate.name || candidate.id || `application-${index + 1}`,
      kind: candidate.kind || "application",
      source: candidate.source || "root",
      workingDirectory: candidate.workingDirectory || ".",
      packageDirectory: candidate.packageDirectory || ".",
      dependsOn: candidate.dependsOn || [],
      environment: candidate.environment || {},
      restartAttempts: candidate.restartAttempts ?? 1,
      evidence: candidate.evidence || []
    };
  });
  const startupOrder = legacy.startupOrder?.filter((id) =>
    startCommands.some((service) => service.id === id)
  );
  const healthChecks = (legacy.healthChecks || []).map((check) => ({
    ...check,
    startupTimeoutMs: check.startupTimeoutMs || (check.type === "http" ? 45_000 : 5_000)
  }));
  for (const service of startCommands) {
    if (!healthChecks.some((check) => check.serviceId === service.id)) {
      healthChecks.push(service.port
        ? {
            serviceId: service.id,
            type: "http",
            port: service.port,
            path: "/",
            startupTimeoutMs: 45_000
          }
        : {
            serviceId: service.id,
            type: "process",
            startupTimeoutMs: 5_000
          });
    }
  }

  return {
    ...legacy,
    version: 2,
    repositoryKind: legacy.repositoryKind || "single-package",
    workspacePatterns: legacy.workspacePatterns || [],
    composeFiles: legacy.composeFiles || [],
    installCommands: legacy.installCommands || (legacy.installCommand?.length
      ? [{ id: "install:root", command: legacy.installCommand, workingDirectory: "." }]
      : []),
    buildCommands: legacy.buildCommands || (legacy.buildCommand
      ? [{ id: "build:root", command: legacy.buildCommand, workingDirectory: "." }]
      : []),
    migrationCommands: legacy.migrationCommands || (legacy.migrationCommand
      ? [{ id: "migrate:root", command: legacy.migrationCommand, workingDirectory: "." }]
      : []),
    testCommands: (legacy.testCommands || []).map((test) => ({
      ...test,
      workingDirectory: test.workingDirectory || "."
    })),
    startCommands,
    startupOrder: startupOrder?.length === startCommands.length
      ? startupOrder
      : orderServices(startCommands, issues),
    healthChecks,
    issues
  };
}

async function describePackages(
  root: string,
  packageFiles: string[],
  rootPackage: PackageJson | undefined,
  workspacePatterns: string[],
  issues: string[]
): Promise<PackageDescriptor[]> {
  const descriptors: PackageDescriptor[] = [];
  for (const packageFile of packageFiles) {
    const absoluteDirectory = path.dirname(packageFile);
    const relativeDirectory = normalizeRelative(path.relative(root, absoluteDirectory));
    const packageJson = relativeDirectory === "." && rootPackage
      ? rootPackage
      : await readPackageJson(packageFile, issues);
    if (!packageJson) continue;
    const isWorkspace = relativeDirectory !== "." && workspacePatterns.some(
      (pattern) => matchesWorkspacePattern(relativeDirectory, pattern)
    );
    descriptors.push({
      packageJson,
      relativeDirectory,
      absoluteDirectory,
      source: relativeDirectory === "." ? "root" : isWorkspace ? "workspace" : "nested-package",
      packageManager: detectPackageManagerAt(absoluteDirectory, root, packageJson),
      isWorkspace
    });
  }
  return descriptors.sort((a, b) => {
    if (a.relativeDirectory === ".") return -1;
    if (b.relativeDirectory === ".") return 1;
    return a.relativeDirectory.localeCompare(b.relativeDirectory);
  });
}

async function packageService(descriptor: PackageDescriptor): Promise<ServiceCommand | undefined> {
  const scripts = descriptor.packageJson.scripts || {};
  const startScript = scripts.start ? "start" : scripts.dev ? "dev" : undefined;
  if (!startScript) return undefined;

  const dependencies = combinedDependencies(descriptor.packageJson);
  const signals = await discoverPackageSignals(descriptor.absoluteDirectory);
  const kind = classifyService(
    descriptor.packageJson.name || path.basename(descriptor.absoluteDirectory),
    descriptor.relativeDirectory,
    dependencies,
    signals
  );
  const id = serviceId(descriptor.packageJson.name || descriptor.relativeDirectory);
  const port = await discoverPackagePort(descriptor.absoluteDirectory, scripts[startScript], kind, signals);
  return {
    id,
    name: descriptor.packageJson.name || (descriptor.relativeDirectory === "." ? "application" : path.basename(descriptor.absoluteDirectory)),
    kind,
    source: descriptor.source,
    command: commandForPackageScript(descriptor, startScript),
    workingDirectory: descriptor.isWorkspace ? "." : descriptor.relativeDirectory,
    packageDirectory: descriptor.relativeDirectory,
    packageName: descriptor.packageJson.name,
    port,
    dependsOn: [],
    environment: {},
    restartAttempts: 1,
    evidence: [
      `${normalizeRelative(path.join(descriptor.relativeDirectory, "package.json"))}: scripts.${startScript}`,
      ...signals.evidence
    ]
  };
}

function commandForPackageScript(descriptor: PackageDescriptor, script: string): string[] {
  const name = descriptor.packageJson.name;
  if (descriptor.isWorkspace && name) {
    if (descriptor.packageManager === "pnpm") {
      return ["corepack", "pnpm", "--filter", name, "run", script];
    }
    if (descriptor.packageManager === "yarn") {
      return ["corepack", "yarn", "workspace", name, "run", script];
    }
    return ["npm", "run", script, `--workspace=${name}`];
  }
  return commandForScript(descriptor.packageManager, script);
}

function commandForScript(packageManager: PackageManager, script: string): string[] {
  return packageManager === "npm"
    ? ["npm", "run", script]
    : ["corepack", packageManager, "run", script];
}

function discoverInstallCommands(
  root: string,
  packages: PackageDescriptor[],
  repositoryPackageManager: PackageManager,
  issues: string[]
): ExecutionCommand[] {
  const rootLock = lockfileFor(root);
  if (rootLock) {
    return [{
      id: "install:root",
      command: installCommand(repositoryPackageManager, rootLock),
      workingDirectory: "."
    }];
  }

  const commands: ExecutionCommand[] = [];
  for (const descriptor of packages.filter((candidate) => candidate.relativeDirectory !== ".")) {
    const lockfile = lockfileFor(descriptor.absoluteDirectory);
    if (!lockfile) continue;
    commands.push({
      id: `install:${serviceId(descriptor.packageJson.name || descriptor.relativeDirectory)}`,
      command: installCommand(descriptor.packageManager, lockfile),
      workingDirectory: descriptor.relativeDirectory
    });
  }
  if (commands.length === 0 && packages.length > 0) {
    issues.push("No package lockfile was found at the repository root or a runnable nested package.");
  }
  return commands;
}

function installCommand(packageManager: PackageManager, lockfile: string): string[] {
  if (packageManager === "pnpm" || lockfile === "pnpm-lock.yaml") {
    return ["corepack", "pnpm", "install", "--frozen-lockfile"];
  }
  if (packageManager === "yarn" || lockfile === "yarn.lock") {
    return ["corepack", "yarn", "install", "--immutable"];
  }
  return ["npm", "ci"];
}

function discoverLifecycleCommands(
  packages: PackageDescriptor[],
  script: string
): ExecutionCommand[] {
  const root = packages.find((descriptor) => descriptor.relativeDirectory === ".");
  if (root?.packageJson.scripts?.[script]) {
    return [{
      id: `${script}:root`,
      command: commandForScript(root.packageManager, script),
      workingDirectory: "."
    }];
  }
  return packages
    .filter((descriptor) => descriptor.packageJson.scripts?.[script])
    .map((descriptor) => ({
      id: `${script}:${serviceId(descriptor.packageJson.name || descriptor.relativeDirectory)}`,
      serviceId: serviceId(descriptor.packageJson.name || descriptor.relativeDirectory),
      command: commandForPackageScript(descriptor, script),
      workingDirectory: descriptor.isWorkspace ? "." : descriptor.relativeDirectory
    }));
}

function discoverMigrationCommands(packages: PackageDescriptor[]): ExecutionCommand[] {
  const commands: ExecutionCommand[] = [];
  for (const descriptor of packages) {
    const scripts = descriptor.packageJson.scripts || {};
    const script = scripts["db:migrate"] ? "db:migrate" : scripts.migrate ? "migrate" : undefined;
    const dependencies = combinedDependencies(descriptor.packageJson);
    const id = serviceId(descriptor.packageJson.name || descriptor.relativeDirectory);
    if (script) {
      commands.push({
        id: `migrate:${id}`,
        serviceId: id,
        command: commandForPackageScript(descriptor, script),
        workingDirectory: descriptor.isWorkspace ? "." : descriptor.relativeDirectory
      });
    } else if (dependencies.prisma || dependencies["@prisma/client"]) {
      const command = descriptor.packageManager === "npm"
        ? ["npm", "exec", "--", "prisma", "migrate", "deploy"]
        : ["corepack", descriptor.packageManager, "exec", "prisma", "migrate", "deploy"];
      commands.push({
        id: `migrate:${id}`,
        serviceId: id,
        command,
        workingDirectory: descriptor.relativeDirectory
      });
    }
  }
  return deduplicateCommands(commands);
}

function discoverTestCommands(packages: PackageDescriptor[]): TestCommand[] {
  const commands: TestCommand[] = [];
  for (const descriptor of packages) {
    const scripts = descriptor.packageJson.scripts || {};
    const add = (script: string, type: TestCommand["type"]) => {
      if (!scripts[script] || scripts[script].includes("no test specified")) return;
      const id = serviceId(descriptor.packageJson.name || descriptor.relativeDirectory);
      commands.push({
        id: `test:${type}:${id}`,
        serviceId: id,
        type,
        command: commandForPackageScript(descriptor, script),
        workingDirectory: descriptor.isWorkspace ? "." : descriptor.relativeDirectory
      });
    };
    add("test", "unit");
    add("test:integration", "integration");
    add("test:e2e", "e2e");
  }
  return deduplicateCommands(commands);
}

async function discoverComposeServices(
  root: string,
  composeFile: string,
  issues: string[]
): Promise<ComposeService[]> {
  const absolute = path.join(root, composeFile);
  let document: ComposeDocument;
  try {
    document = parseYaml(await fs.promises.readFile(absolute, "utf8")) as ComposeDocument;
  } catch (error) {
    issues.push(`INVALID_COMPOSE_FILE: ${composeFile}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }

  const result: ComposeService[] = [];
  for (const [name, definition] of Object.entries(document.services || {})) {
    const workingDirectory = composeHostWorkingDirectory(root, path.dirname(absolute), definition);
    const port = composePort(definition.ports);
    const command = Array.isArray(definition.command)
      ? definition.command.map(String)
      : typeof definition.command === "string"
        ? ["sh", "-lc", definition.command]
        : [];
    const build = composeBuild(root, path.dirname(absolute), definition.build);
    result.push({
      name,
      command,
      workingDirectory,
      port,
      dependsOn: Array.isArray(definition.depends_on)
        ? definition.depends_on
        : Object.keys(definition.depends_on || {}),
      environment: composeEnvironment(definition.environment),
      image: definition.image,
      build,
      healthCheck: composeHealthCheck(definition.healthcheck, port),
      evidence: [`${composeFile}: services.${name}`]
    });
  }
  return result;
}

function mergeComposeServices(
  packageServices: ServiceCommand[],
  composeServices: ComposeService[]
): ServiceCommand[] {
  const result = [...packageServices];
  const composeNameToServiceId = new Map<string, string>();

  for (const compose of composeServices) {
    const existing = result.find((service) =>
      service.id === serviceId(compose.name) ||
      service.packageDirectory === compose.workingDirectory ||
      service.name === compose.name
    );
    if (existing) {
      composeNameToServiceId.set(compose.name, existing.id);
      existing.port ||= compose.port;
      existing.environment = { ...compose.environment, ...existing.environment };
      existing.image ||= compose.image;
      existing.build ||= compose.build;
      existing.dependsOn.push(...compose.dependsOn);
      existing.evidence.push(...compose.evidence);
      if (existing.command.length === 0) existing.command = compose.command;
      continue;
    }

    const id = serviceId(compose.name);
    composeNameToServiceId.set(compose.name, id);
    result.push({
      id,
      name: compose.name,
      kind: classifyService(compose.name, compose.workingDirectory, {}, {
        hasHttpServer: Boolean(compose.port),
        hasWorker: /worker|consumer|queue|job/i.test(compose.name),
        hasFrontend: /web|front|client|ui/i.test(compose.name)
      }),
      source: "compose",
      command: compose.command,
      workingDirectory: compose.workingDirectory,
      packageDirectory: compose.workingDirectory,
      port: compose.port,
      dependsOn: compose.dependsOn,
      environment: compose.environment,
      image: compose.image,
      build: compose.build,
      restartAttempts: 1,
      evidence: compose.evidence
    });
  }

  for (const service of result) {
    service.dependsOn = [...new Set(service.dependsOn
      .map((dependency) => composeNameToServiceId.get(dependency) || serviceId(dependency))
      .filter((dependency) => dependency !== service.id && result.some((candidate) => candidate.id === dependency)))];
  }
  return deduplicateServices(result);
}

function orderServices(services: ServiceCommand[], issues: string[]): string[] {
  const priorities: Record<ServiceKind, number> = {
    api: 10,
    application: 20,
    worker: 30,
    frontend: 40
  };
  const remaining = new Map(services.map((service) => [service.id, new Set(service.dependsOn)]));
  const ordered: string[] = [];

  while (remaining.size > 0) {
    const ready = services
      .filter((service) => remaining.has(service.id) && (remaining.get(service.id)?.size || 0) === 0)
      .sort((a, b) => priorities[a.kind] - priorities[b.kind] || a.name.localeCompare(b.name));
    if (ready.length === 0) {
      const cyclic = [...remaining.keys()].sort();
      issues.push(`SERVICE_DEPENDENCY_CYCLE: ${cyclic.join(" -> ")}`);
      ordered.push(...cyclic);
      break;
    }
    for (const service of ready) {
      ordered.push(service.id);
      remaining.delete(service.id);
      for (const dependencies of remaining.values()) dependencies.delete(service.id);
    }
  }
  return ordered;
}

function classifyService(
  name: string,
  relativeDirectory: string,
  dependencies: Record<string, string>,
  signals: {
    hasHttpServer: boolean;
    hasWorker: boolean;
    hasFrontend: boolean;
  }
): ServiceKind {
  const identity = `${name} ${relativeDirectory}`.toLowerCase();
  const dependencyNames = new Set(Object.keys(dependencies));
  if (
    signals.hasFrontend ||
    ["next", "react", "react-dom", "vite", "vue", "@angular/core", "svelte"].some((item) => dependencyNames.has(item)) ||
    /(?:^|[/_.-])(web|frontend|client|ui)(?:$|[/_.-])/.test(identity)
  ) return "frontend";
  if (
    signals.hasWorker ||
    ["bull", "bullmq", "amqplib", "kafkajs"].some((item) => dependencyNames.has(item)) ||
    /(?:^|[/_.-])(worker|consumer|jobs?)(?:$|[/_.-])/.test(identity)
  ) return "worker";
  if (
    signals.hasHttpServer ||
    ["express", "fastify", "@nestjs/core", "koa", "@hapi/hapi"].some((item) => dependencyNames.has(item)) ||
    /(?:^|[/_.-])(api|server|backend)(?:$|[/_.-])/.test(identity)
  ) return "api";
  return "application";
}

async function discoverPackageSignals(directory: string): Promise<{
  hasHttpServer: boolean;
  hasWorker: boolean;
  hasFrontend: boolean;
  evidence: string[];
}> {
  const files = await listSourceFiles(directory, 120);
  let hasHttpServer = false;
  let hasWorker = false;
  let hasFrontend = false;
  const evidence: string[] = [];
  for (const file of files) {
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat || stat.size > 512 * 1024) continue;
    const content = await fs.promises.readFile(file, "utf8").catch(() => "");
    const relative = normalizeRelative(path.relative(directory, file));
    if (!hasHttpServer && /(?:\.listen\s*\(|createServer\s*\(|express\s*\(|Fastify\s*\()/m.test(content)) {
      hasHttpServer = true;
      evidence.push(`${relative}: HTTP server signal`);
    }
    if (!hasWorker && /new\s+(?:Worker|QueueEvents)\s*\(|\.process\s*\(/m.test(content)) {
      hasWorker = true;
      evidence.push(`${relative}: background worker signal`);
    }
    if (!hasFrontend && /(?:from\s+["']react["']|next\/(?:navigation|router)|createRoot\s*\()/m.test(content)) {
      hasFrontend = true;
      evidence.push(`${relative}: frontend signal`);
    }
  }
  return { hasHttpServer, hasWorker, hasFrontend, evidence };
}

async function discoverPackagePort(
  directory: string,
  startScript: string,
  kind: ServiceKind,
  signals: { hasHttpServer: boolean }
): Promise<number | undefined> {
  const ports = new Set<number>();
  for (const envName of [".env.example", ".env.sample", ".env.test"]) {
    const envPath = path.join(directory, envName);
    if (!fs.existsSync(envPath)) continue;
    const content = await fs.promises.readFile(envPath, "utf8");
    for (const match of content.matchAll(/(?:^|\n)(?:PORT|APP_PORT|HTTP_PORT)\s*=\s*(\d{2,5})/g)) {
      ports.add(Number(match[1]));
    }
  }
  for (const match of startScript.matchAll(/(?:--port|-p)\s*(?:=|\s)\s*(\d{2,5})/g)) {
    ports.add(Number(match[1]));
  }

  const files = await listSourceFiles(directory, 120);
  for (const file of files) {
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat || stat.size > 512 * 1024) continue;
    const content = await fs.promises.readFile(file, "utf8").catch(() => "");
    for (const pattern of [
      /\.listen\(\s*(\d{2,5})\b/g,
      /process\.env\.(?:PORT|APP_PORT|HTTP_PORT)\s*(?:\|\||\?\?)\s*(?:Number\()?["']?(\d{2,5})/g
    ]) {
      for (const match of content.matchAll(pattern)) ports.add(Number(match[1]));
    }
  }
  if (ports.size > 0) return [...ports][0];
  if (kind === "frontend") return 3000;
  if (kind === "api" || signals.hasHttpServer) return 4000;
  return undefined;
}

async function discoverWorkspacePatterns(
  root: string,
  rootPackage: PackageJson | undefined,
  issues: string[]
): Promise<string[]> {
  const patterns = new Set<string>();
  const configured = Array.isArray(rootPackage?.workspaces)
    ? rootPackage?.workspaces
    : rootPackage?.workspaces?.packages;
  configured?.forEach((pattern) => patterns.add(normalizeWorkspacePattern(pattern)));

  const pnpmWorkspace = path.join(root, "pnpm-workspace.yaml");
  if (fs.existsSync(pnpmWorkspace)) {
    try {
      const document = parseYaml(await fs.promises.readFile(pnpmWorkspace, "utf8")) as { packages?: string[] };
      document.packages?.forEach((pattern) => patterns.add(normalizeWorkspacePattern(pattern)));
    } catch (error) {
      issues.push(`INVALID_PNPM_WORKSPACE: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...patterns].filter(Boolean);
}

function matchesWorkspacePattern(relativeDirectory: string, pattern: string): boolean {
  if (pattern.startsWith("!")) return false;
  const normalized = normalizeWorkspacePattern(pattern);
  const regex = new RegExp(`^${normalized
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]")}$`);
  return regex.test(relativeDirectory);
}

function detectRepositoryPackageManager(
  root: string,
  rootPackage: PackageJson | undefined,
  packages: PackageDescriptor[]
): PackageManager {
  const declared = rootPackage?.packageManager?.split("@")[0];
  if (declared === "pnpm" || declared === "yarn" || declared === "npm") return declared;
  const lock = lockfileFor(root);
  if (lock === "pnpm-lock.yaml") return "pnpm";
  if (lock === "yarn.lock") return "yarn";
  if (lock === "package-lock.json") return "npm";
  return packages[0]?.packageManager || "npm";
}

function detectPackageManagerAt(directory: string, root: string, packageJson: PackageJson): PackageManager {
  const declared = packageJson.packageManager?.split("@")[0];
  if (declared === "pnpm" || declared === "yarn" || declared === "npm") return declared;
  for (const candidate of [directory, root]) {
    const lock = lockfileFor(candidate);
    if (lock === "pnpm-lock.yaml") return "pnpm";
    if (lock === "yarn.lock") return "yarn";
    if (lock === "package-lock.json") return "npm";
  }
  return "npm";
}

function lockfileFor(directory: string): string | undefined {
  return ["pnpm-lock.yaml", "yarn.lock", "package-lock.json"]
    .find((name) => fs.existsSync(path.join(directory, name)));
}

async function discoverEnvironmentRequirements(
  repositoryRoot: string,
  services: ServiceCommand[]
): Promise<EnvironmentRequirement[]> {
  const requirements = new Map<string, EnvironmentRequirement>();
  for (const service of services) {
    const serviceRoot = path.resolve(repositoryRoot, service.packageDirectory || service.workingDirectory);
    for (const envName of [".env.example", ".env.sample"]) {
      const envPath = path.join(serviceRoot, envName);
      if (!fs.existsSync(envPath)) continue;
      const content = await fs.promises.readFile(envPath, "utf8");
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
        if (match) {
          requirements.set(`${service.id}:${match[1]}`, {
            name: match[1],
            required: true,
            source: normalizeRelative(path.relative(repositoryRoot, envPath)),
            serviceId: service.id
          });
        }
      }
    }

    const files = await listSourceFiles(serviceRoot, 200);
    for (const file of files) {
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat || stat.size > 1024 * 1024) continue;
      const content = await fs.promises.readFile(file, "utf8").catch(() => "");
      for (const match of content.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
        const key = `${service.id}:${match[1]}`;
        if (!requirements.has(key)) {
          requirements.set(key, {
            name: match[1],
            required: true,
            source: normalizeRelative(path.relative(repositoryRoot, file)),
            serviceId: service.id
          });
        }
      }
    }
  }

  for (const service of services) {
    for (const [name, value] of Object.entries(service.environment)) {
      for (const match of value.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::?-[^}]*)?\}/g)) {
        const key = `${service.id}:${match[1]}`;
        requirements.set(key, {
          name: match[1],
          required: !value.includes(":-") && !value.includes("-"),
          source: service.evidence[0] || "compose",
          serviceId: service.id
        });
      }
      if (value === "" && /^[A-Z][A-Z0-9_]*$/.test(name)) {
        requirements.set(`${service.id}:${name}`, {
          name,
          required: true,
          source: service.evidence[0] || "compose",
          serviceId: service.id
        });
      }
    }
  }
  return [...requirements.values()].sort((a, b) =>
    (a.serviceId || "").localeCompare(b.serviceId || "") || a.name.localeCompare(b.name)
  );
}

function dependencyTypeForComposeService(service: ComposeService): DependencyService["type"] | undefined {
  const identity = `${service.name} ${service.image || ""}`.toLowerCase();
  if (/postgres|timescale|cockroach/.test(identity)) return "postgresql";
  if (/redis|valkey/.test(identity)) return "redis";
  if (/mongo/.test(identity)) return "mongodb";
  return undefined;
}

function addDependencyEvidence(
  target: Map<DependencyService["type"], Set<string>>,
  type: DependencyService["type"],
  dependencies: Record<string, string>,
  names: string[],
  relativeDirectory: string
) {
  const matches = names.filter((name) => dependencies[name]);
  if (matches.length === 0) return;
  const evidence = target.get(type) || new Set<string>();
  matches.forEach((name) => evidence.add(
    `${normalizeRelative(path.join(relativeDirectory, "package.json"))}: dependency ${name}`
  ));
  target.set(type, evidence);
}

function composePort(ports: ComposeServiceDefinition["ports"]): number | undefined {
  for (const port of ports || []) {
    if (typeof port === "number") return port;
    if (typeof port === "object" && port.target) return Number(port.target);
    if (typeof port === "string") {
      const withoutProtocol = port.split("/")[0];
      const target = withoutProtocol.split(":").pop();
      const parsed = Number(target);
      if (Number.isInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return undefined;
}

function composeEnvironment(
  environment: ComposeServiceDefinition["environment"]
): Record<string, string> {
  if (!environment) return {};
  if (Array.isArray(environment)) {
    return Object.fromEntries(environment.map((entry) => {
      const separator = entry.indexOf("=");
      return separator === -1
        ? [entry, ""]
        : [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
  }
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => [name, value == null ? "" : String(value)])
  );
}

function composeBuild(
  root: string,
  composeDirectory: string,
  build: ComposeServiceDefinition["build"]
): ServiceBuild | undefined {
  if (!build) return undefined;
  const contextValue = typeof build === "string" ? build : build.context || ".";
  const absoluteContext = path.resolve(composeDirectory, contextValue);
  if (!isInside(root, absoluteContext)) return undefined;
  return {
    context: normalizeRelative(path.relative(root, absoluteContext)),
    dockerfile: typeof build === "object" ? build.dockerfile : undefined
  };
}

function composeHostWorkingDirectory(
  root: string,
  composeDirectory: string,
  definition: ComposeServiceDefinition
): string {
  const containerWorkingDirectory = definition.working_dir;
  for (const volume of definition.volumes || []) {
    const source = typeof volume === "string" ? volume.split(":")[0] : volume.source;
    const target = typeof volume === "string" ? volume.split(":")[1] : volume.target;
    if (!source || !target || !containerWorkingDirectory) continue;
    if (containerWorkingDirectory === target || containerWorkingDirectory.startsWith(`${target}/`)) {
      const suffix = containerWorkingDirectory.slice(target.length).replace(/^[/\\]/, "");
      const absolute = path.resolve(composeDirectory, source, suffix);
      if (isInside(root, absolute)) return normalizeRelative(path.relative(root, absolute));
    }
  }
  const build = composeBuild(root, composeDirectory, definition.build);
  return build?.context || ".";
}

function composeHealthCheck(
  healthcheck: ComposeServiceDefinition["healthcheck"],
  port?: number
): Omit<HealthCheck, "serviceId"> | undefined {
  if (!healthcheck) return undefined;
  const test = Array.isArray(healthcheck.test)
    ? healthcheck.test.join(" ")
    : healthcheck.test || "";
  const url = test.match(/https?:\/\/(?:localhost|127\.0\.0\.1)?(?::\d+)?(\/[^\s"']*)?/i);
  const timeout = parseComposeDuration(healthcheck.start_period) +
    (healthcheck.retries || 20) * Math.max(parseComposeDuration(healthcheck.interval), 500);
  if (/curl|wget|http/i.test(test) && port) {
    return {
      type: "http",
      port,
      path: url?.[1] || "/",
      startupTimeoutMs: Math.max(timeout, 10_000)
    };
  }
  if (port) {
    return {
      type: "tcp",
      port,
      startupTimeoutMs: Math.max(timeout, 10_000)
    };
  }
  return {
    type: "process",
    startupTimeoutMs: Math.max(timeout, 5_000)
  };
}

function parseComposeDuration(value?: string): number {
  if (!value) return 0;
  const match = String(value).match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
  if (!match) return 0;
  const amount = Number(match[1]);
  return amount * (match[2] === "m" ? 60_000 : match[2] === "ms" ? 1 : 1_000);
}

function combinedDependencies(packageJson: PackageJson): Record<string, string> {
  return { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
}

async function readPackageJson(file: string, issues: string[]): Promise<PackageJson | undefined> {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf8")) as PackageJson;
  } catch (error) {
    issues.push(`INVALID_PACKAGE_JSON: ${normalizeRelative(file)}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

async function findPackageJsonFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0 && files.length < 500) {
    const current = pending.pop()!;
    const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) {
        pending.push(path.join(current, entry.name));
      } else if (entry.isFile() && entry.name === "package.json") {
        files.push(path.join(current, entry.name));
      }
    }
  }
  return files;
}

async function listSourceFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  const extensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
  while (pending.length > 0 && files.length < limit) {
    const current = pending.pop()!;
    const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= limit) break;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry.name)) pending.push(absolute);
      if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(absolute);
    }
  }
  return files;
}

function deduplicateCommands<T extends ExecutionCommand>(commands: T[]): T[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = `${command.workingDirectory}\0${command.command.join("\0")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function deduplicateServices(services: ServiceCommand[]): ServiceCommand[] {
  const result = new Map<string, ServiceCommand>();
  for (const service of services) {
    const existing = result.get(service.id);
    if (!existing) {
      result.set(service.id, service);
      continue;
    }
    existing.evidence.push(...service.evidence);
    existing.dependsOn = [...new Set([...existing.dependsOn, ...service.dependsOn])];
    existing.environment = { ...service.environment, ...existing.environment };
    existing.port ||= service.port;
    existing.image ||= service.image;
    existing.build ||= service.build;
  }
  return [...result.values()];
}

function serviceId(value: string): string {
  const normalized = value
    .replace(/^@/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized || "application";
}

function normalizeWorkspacePattern(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function normalizeRelative(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized === "" ? "." : normalized;
}

function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}
