import fs from "node:fs";
import path from "node:path";

export type PackageManager = "npm" | "pnpm" | "yarn";

export interface TestCommand {
  id: string;
  type: "unit" | "integration" | "e2e";
  command: string[];
}

export interface ServiceCommand {
  id: string;
  name: string;
  command: string[];
  port?: number;
}

export interface DependencyService {
  type: "postgresql" | "redis" | "mongodb";
  required: boolean;
  evidence: string[];
}

export interface HealthCheck {
  serviceId: string;
  type: "http" | "tcp";
  port: number;
  path?: string;
}

export interface EnvironmentRequirement {
  name: string;
  required: boolean;
  source: string;
}

export interface ExecutionManifest {
  version: 1;
  supported: boolean;
  packageManager: PackageManager;
  installCommand: string[];
  buildCommand?: string[];
  migrationCommand?: string[];
  testCommands: TestCommand[];
  startCommands: ServiceCommand[];
  services: DependencyService[];
  ports: number[];
  healthChecks: HealthCheck[];
  requiredEnvironment: EnvironmentRequirement[];
  issues: string[];
}

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export async function discoverExecutionManifest(repositoryRoot: string): Promise<ExecutionManifest> {
  const packageJsonPath = path.join(repositoryRoot, "package.json");
  const issues: string[] = [];
  let packageJson: PackageJson = {};

  if (!fs.existsSync(packageJsonPath)) {
    issues.push("UNSUPPORTED_STACK: Root package.json was not found. The first runtime slice supports Node.js repositories only.");
  } else {
    try {
      packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, "utf8")) as PackageJson;
    } catch (error) {
      issues.push(`INVALID_PACKAGE_JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const packageManager = detectPackageManager(repositoryRoot);
  const installCommand = getInstallCommand(repositoryRoot, packageManager, issues);
  const scripts = packageJson.scripts || {};
  const dependencies = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) };
  const commandForScript = (script: string) => packageManager === "npm"
    ? ["npm", "run", script]
    : ["corepack", packageManager, "run", script];

  const testCommands: TestCommand[] = [];
  if (scripts.test && !scripts.test.includes("no test specified")) {
    testCommands.push({ id: "unit", type: "unit", command: commandForScript("test") });
  }
  if (scripts["test:integration"]) {
    testCommands.push({ id: "integration", type: "integration", command: commandForScript("test:integration") });
  }
  if (scripts["test:e2e"]) {
    testCommands.push({ id: "e2e", type: "e2e", command: commandForScript("test:e2e") });
  }

  const ports = await discoverPorts(repositoryRoot, dependencies);
  const startCommands: ServiceCommand[] = [];
  const startScript = scripts.start ? "start" : scripts.dev ? "dev" : undefined;
  if (startScript) {
    startCommands.push({
      id: "application",
      name: "application",
      command: commandForScript(startScript),
      port: ports[0]
    });
  }

  const services = discoverDependencyServices(dependencies);
  const migrationCommand = discoverMigrationCommand(packageManager, scripts, dependencies);
  const requiredEnvironment = await discoverEnvironmentRequirements(repositoryRoot);
  const healthChecks = startCommands
    .filter((service): service is ServiceCommand & { port: number } => typeof service.port === "number")
    .map((service) => ({
      serviceId: service.id,
      type: "http" as const,
      port: service.port,
      path: "/"
    }));

  if (installCommand.length === 0) {
    issues.push("LOCKFILE_REQUIRED: Deterministic dependency installation requires package-lock.json, pnpm-lock.yaml, or yarn.lock.");
  }
  if (testCommands.length === 0) {
    issues.push("TEST_COMMAND_NOT_CONFIGURED: No supported test script was discovered.");
  }
  if (startCommands.length === 0) {
    issues.push("START_COMMAND_NOT_CONFIGURED: Neither a start nor dev script was discovered.");
  }
  if (startCommands.length > 0 && ports.length === 0) {
    issues.push(
      "APPLICATION_PORT_NOT_DISCOVERED: Runtime verification requires a declared PORT or a statically discoverable listen port."
    );
  }

  return {
    version: 1,
    supported:
      fs.existsSync(packageJsonPath) &&
      installCommand.length > 0 &&
      startCommands.length > 0 &&
      ports.length > 0,
    packageManager,
    installCommand,
    buildCommand: scripts.build ? commandForScript("build") : undefined,
    migrationCommand,
    testCommands,
    startCommands,
    services,
    ports,
    healthChecks,
    requiredEnvironment,
    issues
  };
}

function discoverMigrationCommand(
  packageManager: PackageManager,
  scripts: Record<string, string>,
  dependencies: Record<string, string>
): string[] | undefined {
  const script = scripts["db:migrate"] ? "db:migrate" : scripts.migrate ? "migrate" : undefined;
  if (script) {
    return packageManager === "npm"
      ? ["npm", "run", script]
      : ["corepack", packageManager, "run", script];
  }
  if (dependencies.prisma || dependencies["@prisma/client"]) {
    if (packageManager === "npm") return ["npm", "exec", "--", "prisma", "migrate", "deploy"];
    return ["corepack", packageManager, "exec", "prisma", "migrate", "deploy"];
  }
  return undefined;
}

function detectPackageManager(repositoryRoot: string): PackageManager {
  if (fs.existsSync(path.join(repositoryRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(repositoryRoot, "yarn.lock"))) return "yarn";
  return "npm";
}

function getInstallCommand(
  repositoryRoot: string,
  packageManager: PackageManager,
  issues: string[]
): string[] {
  if (packageManager === "pnpm" && fs.existsSync(path.join(repositoryRoot, "pnpm-lock.yaml"))) {
    return ["corepack", "pnpm", "install", "--frozen-lockfile"];
  }
  if (packageManager === "yarn" && fs.existsSync(path.join(repositoryRoot, "yarn.lock"))) {
    return ["corepack", "yarn", "install", "--immutable"];
  }
  if (fs.existsSync(path.join(repositoryRoot, "package-lock.json"))) {
    return ["npm", "ci"];
  }
  issues.push(`No lockfile found for detected package manager ${packageManager}.`);
  return [];
}

function discoverDependencyServices(dependencies: Record<string, string>): DependencyService[] {
  const names = new Set(Object.keys(dependencies));
  const result: DependencyService[] = [];

  const add = (type: DependencyService["type"], evidence: string[]) => {
    if (evidence.length > 0) result.push({ type, required: true, evidence });
  };

  add("postgresql", ["pg", "postgres", "postgresql", "@prisma/client", "prisma"].filter((name) => names.has(name)));
  add("redis", ["redis", "ioredis", "bull", "bullmq"].filter((name) => names.has(name)));
  add("mongodb", ["mongodb", "mongoose"].filter((name) => names.has(name)));
  return result;
}

async function discoverPorts(
  repositoryRoot: string,
  dependencies: Record<string, string>
): Promise<number[]> {
  const ports = new Set<number>();
  const envExample = path.join(repositoryRoot, ".env.example");
  if (fs.existsSync(envExample)) {
    const content = await fs.promises.readFile(envExample, "utf8");
    for (const match of content.matchAll(/(?:^|\n)(?:PORT|APP_PORT|HTTP_PORT)\s*=\s*(\d{2,5})/g)) {
      ports.add(Number(match[1]));
    }
  }
  if (ports.size === 0 && (dependencies.next || dependencies.express)) {
    ports.add(3000);
  }
  if (ports.size === 0) {
    const files = await listSourceFiles(repositoryRoot, 200);
    for (const file of files) {
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat || stat.size > 512 * 1024) continue;
      const content = await fs.promises.readFile(file, "utf8").catch(() => "");
      const patterns = [
        /\.listen\(\s*(\d{2,5})\b/g,
        /process\.env\.PORT\s*(?:\|\||\?\?)\s*(\d{2,5})\b/g
      ];
      for (const pattern of patterns) {
        for (const match of content.matchAll(pattern)) ports.add(Number(match[1]));
      }
    }
  }
  return [...ports];
}

async function discoverEnvironmentRequirements(repositoryRoot: string): Promise<EnvironmentRequirement[]> {
  const requirements = new Map<string, EnvironmentRequirement>();
  const envExample = path.join(repositoryRoot, ".env.example");
  if (fs.existsSync(envExample)) {
    const content = await fs.promises.readFile(envExample, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
      if (match) requirements.set(match[1], { name: match[1], required: true, source: ".env.example" });
    }
  }

  const files = await listSourceFiles(repositoryRoot, 500);
  for (const file of files) {
    const stat = await fs.promises.stat(file);
    if (stat.size > 2 * 1024 * 1024) continue;
    const content = await fs.promises.readFile(file, "utf8").catch(() => "");
    for (const match of content.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
      if (!requirements.has(match[1])) {
        requirements.set(match[1], {
          name: match[1],
          required: true,
          source: path.relative(repositoryRoot, file).replace(/\\/g, "/")
        });
      }
    }
  }
  return [...requirements.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function listSourceFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  const excluded = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);
  const extensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);

  while (pending.length > 0 && files.length < limit) {
    const current = pending.pop()!;
    const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= limit) break;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && !excluded.has(entry.name)) pending.push(absolute);
      if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(absolute);
    }
  }
  return files;
}
