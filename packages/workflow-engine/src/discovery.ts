import fs from "node:fs";
import { EndpointContract, HTTPWorkflowConfig, WebSocketContract, WebhookContract, QueueContract, BrowserContract } from "@opspilot/schemas";
import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";
import { mergeEndpointContracts, successfulStatus } from "./contractUtils.js";
import { discoverOpenApiContracts } from "./openApiDiscovery.js";
import { discoverTypeScriptContracts } from "./typescriptContractDiscovery.js";
import { discoverWebSocketContracts } from "./websocketDiscovery.js";
import { discoverWebhookContracts } from "./webhookDiscovery.js";
import { discoverQueueContracts } from "./queueDiscovery.js";
import { discoverBrowserContracts } from "./browserDiscovery.js";
import { StatefulWorkflowPlanner } from "./statefulPlanner.js";

export interface DiscoveredWorkflow {
  name: string;
  description: string;
  source: string;
  contract: EndpointContract;
  steps: Array<{
    name: string;
    type: "HTTP";
    config: HTTPWorkflowConfig;
  }>;
}

export class WorkflowDiscoverer {
  constructor(private readonly dbFallback = false) {}

  public async discoverWebSocketContracts(repoDirectory: string): Promise<WebSocketContract[]> {
    if (!fs.existsSync(repoDirectory)) {
      logger.warn({ repoDirectory }, "WebSocket discovery repository directory does not exist");
      return [];
    }
    const contracts = await discoverWebSocketContracts(repoDirectory);
    logger.info({ repoDirectory, wsContracts: contracts.length }, "WebSocket contract discovery completed");
    return contracts;
  }

  public async discoverWebhookContracts(repoDirectory: string): Promise<WebhookContract[]> {
    if (!fs.existsSync(repoDirectory)) {
      logger.warn({ repoDirectory }, "Webhook discovery repository directory does not exist");
      return [];
    }
    const contracts = await discoverWebhookContracts(repoDirectory);
    logger.info({ repoDirectory, webhookContracts: contracts.length }, "Webhook contract discovery completed");
    return contracts;
  }

  public async discoverQueueContracts(repoDirectory: string): Promise<QueueContract[]> {
    if (!fs.existsSync(repoDirectory)) {
      logger.warn({ repoDirectory }, "Queue discovery repository directory does not exist");
      return [];
    }
    const contracts = await discoverQueueContracts(repoDirectory);
    logger.info({ repoDirectory, queueContracts: contracts.length }, "Queue contract discovery completed");
    return contracts;
  }

  public async discoverBrowserContracts(repoDirectory: string): Promise<BrowserContract[]> {
    if (!fs.existsSync(repoDirectory)) {
      logger.warn({ repoDirectory }, "Browser contract discovery repository directory does not exist");
      return [];
    }
    const contracts = await discoverBrowserContracts(repoDirectory);
    logger.info({ repoDirectory, browserContracts: contracts.length }, "Browser contract discovery completed");
    return contracts;
  }


  public async discover(projectId: string, repoDirectory: string): Promise<DiscoveredWorkflow[]> {
    logger.info({ projectId, repoDirectory }, "Discovering endpoint contracts from repository evidence");
    const contracts = await this.discoverContracts(repoDirectory);
    const workflows = contracts.map((contract) => this.httpWorkflow(contract));

    // Save individual endpoint workflows for retro-compatibility and unit tests
    if (!this.dbFallback) {
      for (const workflow of workflows) {
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

      // Generate and persist the comprehensive stateful workflow
      try {
        const wsContracts = await this.discoverWebSocketContracts(repoDirectory);
        const webhookContracts = await this.discoverWebhookContracts(repoDirectory);
        const queueContracts = await this.discoverQueueContracts(repoDirectory);
        const browserContracts = await this.discoverBrowserContracts(repoDirectory);
        const statefulPlanner = new StatefulWorkflowPlanner();
        const statefulPlan = await statefulPlanner.planWorkflow(projectId, contracts, wsContracts, webhookContracts, queueContracts, browserContracts);
        const name = `Stateful Lifecycle Integration Workflow`;
        const existing = await prisma.syntheticWorkflow.findFirst({
          where: { projectId, name }
        });
        if (!existing) {
          await prisma.syntheticWorkflow.create({
            data: {
              projectId,
              name,
              description: statefulPlan.description,
              steps: statefulPlan.steps as any
            }
          });
          logger.info({ projectId, name }, "Persisted stateful workflow successfully");
        }
      } catch (error) {
        logger.warn({ error }, "Failed to generate or persist stateful lifecycle workflow");
      }
    }
    return workflows;
  }

  public async discoverContracts(repoDirectory: string): Promise<EndpointContract[]> {
    if (!fs.existsSync(repoDirectory)) {
      logger.warn({ repoDirectory }, "Workflow discovery repository directory does not exist");
      return [];
    }
    const [openApi, sourceCode] = await Promise.all([
      discoverOpenApiContracts(repoDirectory),
      discoverTypeScriptContracts(repoDirectory)
    ]);
    const contracts = mergeEndpointContracts([...openApi, ...sourceCode]);
    logger.info({
      repoDirectory,
      openApiContracts: openApi.length,
      sourceContracts: sourceCode.length,
      mergedContracts: contracts.length
    }, "Endpoint contract discovery completed");
    return contracts;
  }

  private httpWorkflow(contract: EndpointContract): DiscoveredWorkflow {
    const name = contract.summary || `${contract.method} ${contract.path}`;
    const expectedStatus = successfulStatus(contract.responses, contract.method);
    return {
      name,
      description: `Repository-derived ${contract.framework} endpoint contract from ${contract.source.file}.`,
      source: contract.source.file,
      contract,
      steps: [{
        name,
        type: "HTTP",
        config: {
          method: contract.method,
          url: contract.path,
          expectedStatus,
          contract
        }
      }]
    };
  }
}
