import crypto from "node:crypto";
import { logger } from "@opspilot/shared";

export interface ReplayOptions {
  initialVariables?: Record<string, unknown>;
  correlationId?: string;
}

export class WorkflowReplayer {
  private driversInstance: any;

  constructor(drivers?: any) {
    this.driversInstance = drivers;
  }

  public async replay(
    workflowSteps: any[],
    options: ReplayOptions = {}
  ): Promise<{
    success: boolean;
    logs: string[];
    variables: Record<string, unknown>;
    correlationId: string;
    stepResults: Array<{
      type: string;
      success: boolean;
      status?: number;
      body?: unknown;
    }>;
  }> {
    if (!this.driversInstance) {
      const { WorkflowDrivers } = await import("@opspilot/workflow-engine");
      this.driversInstance = new WorkflowDrivers();
    }
    logger.info({ stepsCount: workflowSteps.length }, "Replaying original workflow steps against workspace");

    const logs: string[] = [];
    const variables = { ...(options.initialVariables || {}) };
    const correlationId = options.correlationId || crypto.randomUUID();
    const stepResults: Array<{ type: string; success: boolean; status?: number; body?: unknown }> = [];
    let success = true;

    for (const step of workflowSteps) {
      const type = step.type;
      const config = interpolate(step.config || {}, variables) as Record<string, any>;
      config.correlationId = correlationId;
      if (type === "HTTP" || type === "HTTP_REQUEST" || type === "CREATE_USER" || type === "AUTHENTICATE") {
        const repetitions = Math.max(1, Number(config.repetitions || 1));
        let latestBody: unknown;
        let lastStatus: number | undefined;
        let stepSuccess = true;
        for (let attempt = 0; attempt < repetitions; attempt += 1) {
          const res = await this.driversInstance.executeHTTPStep(config as any);
          latestBody = res.body;
          lastStatus = res.status;
          logs.push(res.log);
          if (!res.success) {
            stepSuccess = false;
            success = false;
            break;
          }
        }
        stepResults.push({
          type,
          success: stepSuccess,
          status: lastStatus,
          body: latestBody
        });
        if (!success) break;
        extractVariables(config.extractVariables, latestBody, variables);
      } else if (type === "BROWSER" || type === "BROWSER_ACTION") {
        const res = await this.driversInstance.executeBrowserStep(config as any);
        logs.push(res.log);
        stepResults.push({
          type,
          success: res.success,
          body: res.body
        });
        if (!res.success) {
          success = false;
          break;
        }
      } else if (type === "WEBSOCKET_OPEN") {
        const res = await this.driversInstance.executeWebSocketStep(config as any);
        logs.push(res.log);
        stepResults.push({
          type,
          success: res.success
        });
        if (!res.success) {
          success = false;
          break;
        }
      } else if (type === "SIMULATE_WEBHOOK") {
        const res = await this.driversInstance.executeWebhookStep(config as any);
        logs.push(res.log);
        stepResults.push({
          type,
          success: res.success,
          body: res.body
        });
        if (!res.success) {
          success = false;
          break;
        }
      }
    }

    return {
      success,
      logs,
      variables,
      correlationId,
      stepResults
    };
  }
}

function interpolate(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\${([^}]+)}$/);
    if (exact) return variables[exact[1]] ?? value;
    return value.replace(/\${([^}]+)}/g, (match, name) => {
      const replacement = variables[name];
      return replacement === undefined ? match : String(replacement);
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolate(item, variables));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => [key, interpolate(child, variables)])
    );
  }
  return value;
}

function extractVariables(
  definitions: unknown,
  body: unknown,
  variables: Record<string, unknown>
): void {
  if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) return;
  for (const [name, candidatePaths] of Object.entries(definitions as Record<string, unknown>)) {
    const paths = Array.isArray(candidatePaths) ? candidatePaths : [candidatePaths];
    for (const path of paths) {
      if (typeof path !== "string") continue;
      const value = jsonPath(body, path);
      if (value !== undefined) {
        variables[name] = value;
        break;
      }
    }
  }
}

function jsonPath(value: unknown, expression: string): unknown {
  if (!expression.startsWith("$.")) return undefined;
  const segments = expression.slice(2).split(".").filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
