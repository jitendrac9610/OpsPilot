import fs from "node:fs";
import path from "node:path";
import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export interface DiscoveredWorkflow {
  name: string;
  description: string;
  source: string;
  steps: Array<{
    name: string;
    type: "HTTP";
    config: { method: string; url: string; expectedStatus?: number };
  }>;
}

export class WorkflowDiscoverer {
  constructor(private readonly dbFallback = false) {}

  public async discover(projectId: string, repoDirectory: string): Promise<DiscoveredWorkflow[]> {
    logger.info({ projectId, repoDirectory }, "Discovering workflows from repository evidence");
    if (!fs.existsSync(repoDirectory)) {
      logger.warn({ repoDirectory }, "Workflow discovery repository directory does not exist");
      return [];
    }

    const workflows = [
      ...(await this.discoverOpenApi(repoDirectory)),
      ...(await this.discoverExpressRoutes(repoDirectory)),
      ...(await this.discoverNextRoutes(repoDirectory))
    ];
    const deduplicated = [...new Map(
      workflows.map((workflow) => [`${workflow.steps[0]?.config.method}:${workflow.steps[0]?.config.url}`, workflow])
    ).values()];

    if (!this.dbFallback) {
      for (const workflow of deduplicated) {
        try {
          const existing = await prisma.syntheticWorkflow.findFirst({
            where: { projectId, name: workflow.name }
          });
          if (!existing) {
            await prisma.syntheticWorkflow.create({
              data: {
                projectId,
                name: workflow.name,
                description: workflow.description,
                steps: workflow.steps as any
              }
            });
          }
        } catch (error) {
          logger.warn({ error, workflow: workflow.name }, "Failed to persist discovered workflow");
        }
      }
    }
    return deduplicated;
  }

  private async discoverOpenApi(root: string): Promise<DiscoveredWorkflow[]> {
    const candidates = ["openapi.json", "swagger.json", "docs/openapi.json", "api/openapi.json"];
    const workflows: DiscoveredWorkflow[] = [];

    for (const candidate of candidates) {
      const filePath = path.join(root, candidate);
      if (!fs.existsSync(filePath)) continue;
      try {
        const document = JSON.parse(await fs.promises.readFile(filePath, "utf8")) as {
          paths?: Record<string, Record<string, { summary?: string; responses?: Record<string, unknown> }>>;
        };
        for (const [route, operations] of Object.entries(document.paths || {})) {
          for (const [method, operation] of Object.entries(operations)) {
            if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
            const expectedStatus = Object.keys(operation.responses || {})
              .map(Number)
              .find((status) => status >= 200 && status < 400);
            workflows.push(this.httpWorkflow(
              operation.summary || `${method.toUpperCase()} ${route}`,
              method,
              route,
              candidate,
              expectedStatus
            ));
          }
        }
      } catch (error) {
        logger.warn({ error, filePath }, "Could not parse OpenAPI JSON document");
      }
    }
    return workflows;
  }

  private async discoverExpressRoutes(root: string): Promise<DiscoveredWorkflow[]> {
    const workflows: DiscoveredWorkflow[] = [];
    const files = await listFiles(root);
    const routePattern = /\b(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*["'`]([^"'`]+)["'`]/g;

    for (const filePath of files) {
      const content = await fs.promises.readFile(filePath, "utf8").catch(() => "");
      for (const match of content.matchAll(routePattern)) {
        const source = path.relative(root, filePath).replace(/\\/g, "/");
        workflows.push(this.httpWorkflow(
          `${match[1].toUpperCase()} ${match[2]}`,
          match[1],
          match[2],
          source
        ));
      }
    }
    return workflows;
  }

  private async discoverNextRoutes(root: string): Promise<DiscoveredWorkflow[]> {
    const workflows: DiscoveredWorkflow[] = [];
    const files = await listFiles(root);
    for (const filePath of files) {
      const relative = path.relative(root, filePath).replace(/\\/g, "/");
      const appRoute = relative.match(/(?:^|\/)app\/api\/(.+)\/route\.(?:ts|js|tsx|jsx)$/);
      const pagesRoute = relative.match(/(?:^|\/)pages\/api\/(.+)\.(?:ts|js|tsx|jsx)$/);
      if (!appRoute && !pagesRoute) continue;

      const route = `/api/${(appRoute?.[1] || pagesRoute?.[1] || "")
        .replace(/\/index$/, "")
        .replace(/\[([^\]]+)\]/g, ":$1")}`;
      const content = await fs.promises.readFile(filePath, "utf8").catch(() => "");
      const methods = appRoute
        ? [...content.matchAll(/export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((match) => match[1])
        : ["GET"];
      for (const method of new Set(methods)) {
        workflows.push(this.httpWorkflow(`${method} ${route}`, method, route, relative));
      }
    }
    return workflows;
  }

  private httpWorkflow(
    name: string,
    method: string,
    url: string,
    source: string,
    expectedStatus?: number
  ): DiscoveredWorkflow {
    return {
      name,
      description: `Repository-derived HTTP workflow from ${source}.`,
      source,
      steps: [{
        name,
        type: "HTTP",
        config: { method: method.toUpperCase(), url, expectedStatus }
      }]
    };
  }
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  const excluded = new Set([".git", "node_modules", ".next", "dist", "build", "coverage"]);
  const extensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);

  while (pending.length > 0 && files.length < 5000) {
    const current = pending.pop()!;
    const entries = await fs.promises.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && !excluded.has(entry.name)) pending.push(absolute);
      if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(absolute);
    }
  }
  return files;
}
