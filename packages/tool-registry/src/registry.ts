import { logger } from "@opspilot/shared";

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
    logger.info({ name, args }, "Executing tool...");
    const tool = this.tools.get(name);
    if (!tool) {
      logger.warn({ name }, "Tool not found in registry");
      return {
        success: false,
        output: { error: "TOOL_NOT_REGISTERED", tool: name }
      };
    }

    try {
      const output = await tool.handler(args);
      return { success: true, output };
    } catch (err: any) {
      logger.error({ err, name }, "Tool execution failed");
      return { success: false, output: err.message || "Unknown tool execution error" };
    }
  }

  private registerDefaultTools() {
    // 1. Repository Tools
    this.register({
      name: "list_files",
      description: "Lists all files in the current repository workspace",
      parameters: {},
      handler: async () => this.notConfigured("list_files")
    });

    this.register({
      name: "view_file",
      description: "Views the contents of a specific file in the workspace",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      },
      handler: async () => this.notConfigured("view_file")
    });

    // 2. Static Analysis Tools
    this.register({
      name: "run_static_analysis",
      description: "Runs static analysis to detect code issues and failures",
      parameters: {},
      handler: async () => this.notConfigured("run_static_analysis")
    });

    // 3. Runtime Tools
    this.register({
      name: "list_services",
      description: "Lists all running services in the current environment",
      parameters: {},
      handler: async () => this.notConfigured("list_services")
    });

    this.register({
      name: "view_logs",
      description: "Retrieves logs for a given service",
      parameters: {
        type: "object",
        properties: { service: { type: "string" } },
        required: ["service"]
      },
      handler: async () => this.notConfigured("view_logs")
    });

    // 4. Workflow Tools
    this.register({
      name: "run_tests",
      description: "Runs the test suite for verification or reproduction",
      parameters: {
        type: "object",
        properties: { suite: { type: "string" } }
      },
      handler: async () => this.notConfigured("run_tests")
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
      handler: async () => this.notConfigured("apply_patch")
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
      handler: async () => this.notConfigured("restart_service")
    });

    this.register({
      name: "rollback_deployment",
      description: "Rolls back a deployment to a previous healthy release",
      parameters: {
        type: "object",
        properties: { deploymentId: { type: "string" } },
        required: ["deploymentId"]
      },
      handler: async () => this.notConfigured("rollback_deployment")
    });

    // Other tools can be dynamically registered
    this.register({
      name: "approve_action",
      description: "Approves a pending action",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"]
      },
      handler: async () => this.notConfigured("approve_action")
    });

    this.register({
      name: "apply_approved_changes",
      description: "Applies approved changes to the environment",
      parameters: {},
      handler: async () => this.notConfigured("apply_approved_changes")
    });
  }

  private notConfigured(name: string): never {
    throw new Error(`TOOL_NOT_CONFIGURED: ${name} requires a real runtime adapter.`);
  }
}
