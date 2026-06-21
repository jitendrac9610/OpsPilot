import fs from "node:fs";
import path from "node:path";
import { logger, config } from "@opspilot/shared";
import { prisma } from "@opspilot/database";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: any; // JSON Schema
  handler: (args: any) => Promise<any>;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  constructor() {
    this.registerDefaultTools();
  }

  public register(tool: ToolDefinition) {
    this.tools.set(tool.name, tool);
  }

  public getTool(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  public listTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  public async execute(name: string, args: any): Promise<{ success: boolean; output: any }> {
    logger.info({
      name,
      argumentKeys: args && typeof args === "object" ? Object.keys(args) : []
    }, "Executing tool...");
    const tool = this.tools.get(name);
    if (!tool) {
      logger.warn({ name }, "Tool not found in registry");
      return {
        success: false,
        output: { error: "TOOL_NOT_REGISTERED", tool: name }
      };
    }

    try {
      const validationErrors = validateSchema(tool.parameters, args);
      if (validationErrors.length > 0) {
        return {
          success: false,
          output: {
            error: "INVALID_TOOL_INPUT",
            details: validationErrors
          }
        };
      }
      const output = await tool.handler(args);
      return { success: true, output };
    } catch (err: any) {
      logger.error({ err, name }, "Tool execution failed");
      return { success: false, output: err.message || "Unknown tool execution error" };
    }
  }

  private async getLatestSandbox() {
    const sandbox = await prisma.sandbox.findFirst({
      orderBy: { createdAt: "desc" }
    });
    if (!sandbox) {
      throw new Error("NO_ACTIVE_SANDBOX: No sandbox has been provisioned in the database yet.");
    }
    return sandbox;
  }

  private getSandboxRepoDir(sandboxId: string): string {
    const baseDir = path.resolve(config.tempRoot, "sandboxes");
    return path.resolve(baseDir, sandboxId, "repository");
  }

  private resolveWorkspacePath(repoDir: string, requestedPath: string): string {
    if (!requestedPath || path.isAbsolute(requestedPath)) {
      throw new Error("UNAUTHORIZED_ACCESS: A non-empty repository-relative path is required.");
    }
    const root = path.resolve(repoDir);
    const target = path.resolve(root, requestedPath);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("UNAUTHORIZED_ACCESS: Target path escapes repository directory.");
    }
    const realRoot = fs.realpathSync(root);
    let existingParent = target;
    while (!fs.existsSync(existingParent) && existingParent !== root) {
      existingParent = path.dirname(existingParent);
    }
    const realParent = fs.realpathSync(existingParent);
    const realRelative = path.relative(realRoot, realParent);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
      throw new Error("UNAUTHORIZED_ACCESS: Symlink target escapes repository directory.");
    }
    return target;
  }

  private registerDefaultTools() {
    // 1. Repository Tools
    this.register({
      name: "list_files",
      description: "Lists all files in the current repository workspace",
      parameters: {},
      handler: async () => {
        const sandbox = await this.getLatestSandbox();
        const repoDir = this.getSandboxRepoDir(sandbox.id);

        const listFilesRecursive = (dir: string): string[] => {
          let results: string[] = [];
          if (!fs.existsSync(dir)) return results;
          const list = fs.readdirSync(dir);
          list.forEach((file) => {
            const filePath = path.join(dir, file);
            const stat = fs.lstatSync(filePath);
            if (stat.isSymbolicLink()) {
              return;
            }
            if (stat && stat.isDirectory()) {
              if (!["node_modules", ".git", ".next", "dist", "build"].includes(file)) {
                results = results.concat(listFilesRecursive(filePath));
              }
            } else {
              results.push(path.relative(repoDir, filePath).replace(/\\/g, "/"));
            }
          });
          return results;
        };

        const files = listFilesRecursive(repoDir);
        return { files, count: files.length };
      }
    });

    this.register({
      name: "view_file",
      description: "Views the contents of a specific file in the workspace",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      },
      handler: async (args) => {
        const sandbox = await this.getLatestSandbox();
        const repoDir = this.getSandboxRepoDir(sandbox.id);
        const targetPath = this.resolveWorkspacePath(repoDir, args.path);

        if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
          throw new Error(`FILE_NOT_FOUND: The requested file at ${args.path} was not found.`);
        }
        if (fs.statSync(targetPath).size > 2_000_000) {
          throw new Error("FILE_TOO_LARGE: view_file is limited to 2 MB.");
        }

        const content = fs.readFileSync(targetPath, "utf8");
        return { path: args.path, content };
      }
    });

    // 2. Static Analysis Tools
    this.register({
      name: "run_static_analysis",
      description: "Runs static analysis to detect code issues and failures",
      parameters: {},
      handler: async () => {
        const sandbox = await this.getLatestSandbox();
        const repoDir = this.getSandboxRepoDir(sandbox.id);
        const hasTsConfig = fs.existsSync(path.join(repoDir, "tsconfig.json"));
        const hasPackageJson = fs.existsSync(path.join(repoDir, "package.json"));

        throw new Error(
          `STATIC_ANALYSIS_RUNNER_NOT_CONFIGURED: Repository evidence found package.json=${hasPackageJson}, tsconfig.json=${hasTsConfig}, but no analysis command was executed.`
        );
      }
    });

    // 3. Runtime Tools
    this.register({
      name: "list_services",
      description: "Lists all running services in the current environment",
      parameters: {},
      handler: async () => {
        const sandbox = await this.getLatestSandbox();
        const controllerPort = process.env.SANDBOX_CONTROLLER_PORT || "4010";
        const url = `http://localhost:${controllerPort}/api/sandboxes/${sandbox.id}/services`;

        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Failed to list running services from controller: ${res.statusText}`);
        }
        const data = await res.json() as any;
        return data.services || [];
      }
    });

    this.register({
      name: "view_logs",
      description: "Retrieves logs for a given service",
      parameters: {
        type: "object",
        properties: { service: { type: "string" } },
        required: ["service"]
      },
      handler: async (args) => {
        const sandbox = await this.getLatestSandbox();
        const controllerPort = process.env.SANDBOX_CONTROLLER_PORT || "4010";
        const url = `http://localhost:${controllerPort}/api/sandboxes/${sandbox.id}/logs`;

        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Failed to retrieve logs from controller: ${res.statusText}`);
        }
        const data = await res.json() as any;
        const serviceLogs = data.logs || {};
        return serviceLogs[args.service] || `No logs captured yet for service: ${args.service}`;
      }
    });

    // 4. Workflow Tools
    this.register({
      name: "run_tests",
      description: "Runs the test suite for verification or reproduction",
      parameters: {
        type: "object",
        properties: { suite: { type: "string" } }
      },
      handler: async (args) => {
        const sandbox = await this.getLatestSandbox();
        const controllerPort = process.env.SANDBOX_CONTROLLER_PORT || "4010";
        const url = `http://localhost:${controllerPort}/api/sandboxes/${sandbox.id}/test`;

        const testType = args.suite === "e2e" ? "e2e" : args.suite === "integration" ? "integration" : "unit";

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: testType })
        });

        const data = await res.json() as any;
        return {
          success: res.ok && data.success,
          log: data.log || "No test output returned."
        };
      }
    });

    // 5. Modification Tools
    this.register({
      name: "apply_patch",
      description: "Applies a code patch or modification to a file",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string" },
          patch: { type: "string" }
        },
        required: ["file", "patch"]
      },
      handler: async (args) => {
        const sandbox = await this.getLatestSandbox();
        const repoDir = this.getSandboxRepoDir(sandbox.id);
        const targetPath = this.resolveWorkspacePath(repoDir, args.file);
        if (
          args.patch.startsWith("diff --git") ||
          args.patch.startsWith("--- ") ||
          args.patch.includes("\n@@ ")
        ) {
          throw new Error(
            "UNSUPPORTED_PATCH_FORMAT: Unified diffs require the verified patch applicator; this tool only accepts complete replacement content."
          );
        }
        if (Buffer.byteLength(args.patch, "utf8") > 2_000_000) {
          throw new Error("PATCH_TOO_LARGE: Replacement content is limited to 2 MB.");
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        const temporaryPath = `${targetPath}.opspilot-${process.pid}.tmp`;
        fs.writeFileSync(temporaryPath, args.patch, "utf8");
        fs.renameSync(temporaryPath, targetPath);

        return {
          success: true,
          file: args.file,
          message: `Patch applied successfully to ${args.file}`
        };
      }
    });

    // 6. Approved Production Tools
    this.register({
      name: "restart_service",
      description: "Restarts a service in the active environment (requires approval in production)",
      parameters: {
        type: "object",
        properties: { service: { type: "string" } },
        required: ["service"]
      },
      handler: async (args) => {
        const sandbox = await this.getLatestSandbox();
        const controllerPort = process.env.SANDBOX_CONTROLLER_PORT || "4010";
        const url = `http://localhost:${controllerPort}/api/sandboxes/${sandbox.id}/start`;

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ serviceId: args.service })
        });

        const data = await res.json() as any;
        return {
          success: res.ok && data.success,
          log: data.log || `Service ${args.service} restarted successfully.`
        };
      }
    });

    this.register({
      name: "rollback_deployment",
      description: "Rolls back a deployment to a previous healthy release",
      parameters: {
        type: "object",
        properties: { deploymentId: { type: "string" } },
        required: ["deploymentId"]
      },
      handler: async (args) => {
        throw new Error(
          `ROLLBACK_ADAPTER_NOT_CONFIGURED: Deployment ${args.deploymentId} was not changed.`
        );
      }
    });

    this.register({
      name: "approve_action",
      description: "Approves a pending action",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      },
      handler: async (args) => {
        throw new Error(
          `HUMAN_APPROVAL_REQUIRED: Action ${args.id} cannot be approved by the agent tool registry.`
        );
      }
    });

    this.register({
      name: "apply_approved_changes",
      description: "Applies approved changes to the environment",
      parameters: {},
      handler: async () => {
        throw new Error(
          "APPROVED_CHANGE_EXECUTOR_NOT_CONFIGURED: No changes were applied."
        );
      }
    });
  }
}

function validateSchema(schema: any, value: any, pathLabel = "$"): string[] {
  if (!schema || Object.keys(schema).length === 0) return [];
  const errors: string[] = [];
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [`${pathLabel} must be an object`];
    }
    for (const required of schema.required || []) {
      if (!(required in value)) errors.push(`${pathLabel}.${required} is required`);
    }
    for (const [key, propertySchema] of Object.entries(schema.properties || {})) {
      if (key in value) {
        errors.push(...validateSchema(propertySchema, value[key], `${pathLabel}.${key}`));
      }
    }
    return errors;
  }
  if (schema.type === "string" && typeof value !== "string") {
    errors.push(`${pathLabel} must be a string`);
  } else if (schema.type === "number" && typeof value !== "number") {
    errors.push(`${pathLabel} must be a number`);
  } else if (schema.type === "integer" && !Number.isInteger(value)) {
    errors.push(`${pathLabel} must be an integer`);
  } else if (schema.type === "boolean" && typeof value !== "boolean") {
    errors.push(`${pathLabel} must be a boolean`);
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${pathLabel} must be an array`);
    } else if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateSchema(schema.items, item, `${pathLabel}[${index}]`));
      });
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pathLabel} must be one of ${schema.enum.join(", ")}`);
  }
  return errors;
}
