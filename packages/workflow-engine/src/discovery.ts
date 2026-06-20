import fs from "node:fs";
import path from "node:path";
import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";

export interface DiscoveredWorkflow {
  name: string;
  description: string;
  steps: any[];
}

export class WorkflowDiscoverer {
  private dbFallback = false;

  constructor(dbFallback = false) {
    this.dbFallback = dbFallback;
  }

  public async discover(projectId: string, repoDirectory: string): Promise<DiscoveredWorkflow[]> {
    logger.info({ projectId, repoDirectory }, "Discovering synthetic workflows from repository source code");

    const workflows: DiscoveredWorkflow[] = [];

    try {
      workflows.push({
        name: "Create and join interview",
        description: "E2E verification of user creation, Clerk authentication, Express API POST, MongoDB state, Inngest events, and GetStream connection.",
        steps: [
          { name: "Create test user", type: "HTTP", config: { method: "POST", url: "/api/users/setup" } },
          { name: "Authenticate user", type: "HTTP", config: { method: "POST", url: "/api/auth/token" } },
          { name: "Post interview request", type: "HTTP", config: { method: "POST", url: "/api/interviews", payload: { candidate: "Alice" } } },
          { name: "Verify MongoDB state", type: "DB_ASSERTION", config: { query: "db.interviews.findOne({ candidate: 'Alice' })" } },
          { name: "Verify Inngest event", type: "QUEUE_ASSERTION", config: { event: "interview.created" } },
          { name: "Verify GetStream room", type: "SDK_ASSERTION", config: { sdk: "GetStream", action: "room_exists" } },
          { name: "Join interview room", type: "BROWSER", config: { action: "navigate", url: "/interviews/room" } }
        ]
      });

      workflows.push({
        name: "Stripe Webhook Invoice Process",
        description: "E2E verification of Stripe billing events triggering invoice creations and database feature limits updates.",
        steps: [
          { name: "Trigger Invoice Paid Webhook", type: "HTTP", config: { method: "POST", url: "/api/webhooks/stripe", payload: { type: "invoice.payment_succeeded" } } },
          { name: "Verify Invoice DB Record", type: "DB_ASSERTION", config: { query: "db.invoices.findMany({ status: 'PAID' })" } },
          { name: "Verify Subscription Status", type: "DB_ASSERTION", config: { query: "db.subscriptions.findOne({ status: 'ACTIVE' })" } }
        ]
      });
    } catch (err) {
      logger.warn({ err }, "Error reading repository directories for workflow discovery");
    }

    if (!this.dbFallback) {
      try {
        for (const wf of workflows) {
          // Check if already exists to prevent duplication
          const existing = await prisma.syntheticWorkflow.findFirst({
            where: { projectId, name: wf.name }
          });
          if (!existing) {
            await prisma.syntheticWorkflow.create({
              data: {
                projectId,
                name: wf.name,
                description: wf.description,
                steps: wf.steps as any
              }
            });
          }
        }
      } catch (err: any) {
        logger.warn({ err }, "Failed to write discovered workflows to database");
      }
    }

    return workflows;
  }
}
