import dotenv from "dotenv";
import path from "node:path";
import fs from "node:fs";

// Load environment variables before database prisma import
const rootEnv = path.resolve(process.cwd(), ".env");
const parentEnv = path.resolve(process.cwd(), "../../.env");
if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv });
} else if (fs.existsSync(parentEnv)) {
  dotenv.config({ path: parentEnv });
}

import express, { Request, Response, NextFunction } from "express";
import { Queue } from "bullmq";
import { logger, config, OpsPilotError, EventBus, generateId, generateCorrelationId, generateIdempotencyKey } from "@opspilot/shared";
import { prisma } from "@opspilot/database";

const app = express();
app.use(express.json());

const QUEUE_NAME = "agent-runs";

// Helper to enqueue agent investigation against the exact code version
async function triggerAgentInvestigation(
  incidentId: string,
  title: string,
  serviceId?: string,
  environment = "production",
  timestamp = new Date()
) {
  try {
    const redisUrl = new URL(config.redisUrl);
    const connection = {
      host: redisUrl.hostname || "127.0.0.1",
      port: parseInt(redisUrl.port || "6379", 10),
      username: redisUrl.username || undefined,
      password: redisUrl.password || undefined,
      db: parseInt(redisUrl.pathname.replace("/", "") || "0", 10)
    };

    const agentQueue = new Queue(QUEUE_NAME, { connection });
    
    let snapshotId = "mock-snapshot-id";
    let commitSha = "latest";
    let repositoryId = "mock-repository-id";

    if (serviceId) {
      const service = await prisma.service.findUnique({
        where: { id: serviceId }
      });
      if (service) {
        const workspace = await prisma.repositoryWorkspace.findUnique({
          where: { id: service.workspaceId }
        });
        if (workspace) {
          repositoryId = workspace.repositoryId;
          
          // Find deployment active at the telemetry timestamp
          const deployment = await prisma.deploymentEvent.findFirst({
            where: {
              repositoryId,
              environment,
              createdAt: { lte: timestamp }
            },
            orderBy: { createdAt: "desc" }
          }) || await prisma.deploymentEvent.findFirst({
            // Fallback to the latest deployment overall if none before timestamp
            where: { repositoryId, environment },
            orderBy: { createdAt: "desc" }
          });

          if (deployment) {
            commitSha = deployment.commitSha;
            
            // Find corresponding snapshot
            const snapshot = await prisma.repositorySnapshot.findFirst({
              where: { repositoryId, commitSha }
            });
            if (snapshot) {
              snapshotId = snapshot.id;
            } else {
              logger.warn({ repositoryId, commitSha }, "Deployment commit snapshot not found. Falling back to latest snapshot.");
              const latestSnap = await prisma.repositorySnapshot.findFirst({
                where: { repositoryId },
                orderBy: { createdAt: "desc" }
              });
              if (latestSnap) {
                snapshotId = latestSnap.id;
              }
            }
          } else {
            logger.warn({ repositoryId, environment }, "No deployment event found. Falling back to latest snapshot.");
            const latestSnap = await prisma.repositorySnapshot.findFirst({
              where: { repositoryId },
              orderBy: { createdAt: "desc" }
            });
            if (latestSnap) {
              snapshotId = latestSnap.id;
            }
          }
        }
      }
    }

    if (snapshotId === "mock-snapshot-id") {
      // Fallback: fetch a default snapshotId to link the agent run to code, if it exists
      const latestSnapshot = await prisma.repositorySnapshot.findFirst({
        orderBy: { createdAt: "desc" }
      });
      if (latestSnapshot) {
        snapshotId = latestSnapshot.id;
        repositoryId = latestSnapshot.repositoryId;
        commitSha = latestSnapshot.commitSha;
      }
    }

    const job = await agentQueue.add("investigate-incident", {
      agentRunId: `run_${generateId()}`,
      incidentId,
      snapshotId,
      goal: `Investigate and remediate the production incident: ${title}`,
      isProduction: true
    });

    logger.info({ jobId: job.id, incidentId, snapshotId, commitSha, environment, serviceId }, "Enqueued AI Agent investigation job on BullMQ queue");
  } catch (err: any) {
    logger.warn({ err: err.message, incidentId }, "Redis/BullMQ not available. Incident Worker skipping agent job enqueuing.");
  }
}

// POST /evaluate
app.post("/evaluate", async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info("Starting alert rule evaluation...");

    // 1. Fetch alert rules
    const alertRules = await prisma.alertRule.findMany();
    if (alertRules.length === 0) {
      return res.status(200).json({ status: "success", message: "No alert rules defined. Skipping." });
    }

    // 2. Query ingested metrics from Telemetry API
    const metricsResponse = await fetch("http://localhost:4005/v1/metrics");
    if (!metricsResponse.ok) {
      throw new Error(`Failed to query Telemetry API: ${metricsResponse.statusText}`);
    }
    const metrics: any[] = await metricsResponse.json();

    // 3. Evaluate breaches
    const createdIncidents: any[] = [];
    for (const rule of alertRules) {
      // Find metrics matching rule.metricName
      const matchingMetrics = metrics.filter(m => m.metricName === rule.metricName);
      
      for (const metric of matchingMetrics) {
        if (metric.value > rule.threshold) {
          // Breach detected! Grouping/Deduplication check:
          // Check if an active incident for this metric breach already exists
          const existingIncident = await prisma.incident.findFirst({
            where: {
              title: `Breach: ${rule.metricName} exceeded ${rule.threshold}`,
              status: { in: ["PENDING", "INVESTIGATING", "NEEDS_HUMAN"] }
            }
          });

          if (existingIncident) {
            // Deduplicate: append event to existing incident timeline
            await prisma.incidentEvent.create({
              data: {
                incidentId: existingIncident.id,
                type: "METRIC_BREACH_REPEAT",
                message: `Repeat breach: ${metric.metricName} is currently ${metric.value} (threshold ${rule.threshold})`
              }
            });
            logger.info({ incidentId: existingIncident.id }, "Breach detected. Deduplicated and grouped to existing active incident");
          } else {
            // Create a new incident
            const incident = await prisma.incident.create({
              data: {
                title: `Breach: ${rule.metricName} exceeded ${rule.threshold}`,
                severity: "HIGH",
                status: "PENDING"
              }
            });

            // Log breach event on timeline
            await prisma.incidentEvent.create({
              data: {
                incidentId: incident.id,
                type: "METRIC_BREACH",
                message: `Threshold breached: ${metric.metricName} reached ${metric.value} (threshold ${rule.threshold})`
              }
            });

            // Map incident to service if available
            if (metric.serviceId) {
              await prisma.incidentService.create({
                data: {
                  incidentId: incident.id,
                  serviceId: metric.serviceId
                }
              });
            }

            // Resolve commitSha before publishing and enqueuing
            let resolvedCommitSha = "latest";
            if (metric.serviceId) {
              const service = await prisma.service.findUnique({ where: { id: metric.serviceId } });
              if (service) {
                const workspace = await prisma.repositoryWorkspace.findUnique({ where: { id: service.workspaceId } });
                if (workspace) {
                  const deployment = await prisma.deploymentEvent.findFirst({
                    where: {
                      repositoryId: workspace.repositoryId,
                      environment: "production",
                      createdAt: { lte: new Date(metric.timestamp) }
                    },
                    orderBy: { createdAt: "desc" }
                  }) || await prisma.deploymentEvent.findFirst({
                    where: { repositoryId: workspace.repositoryId, environment: "production" },
                    orderBy: { createdAt: "desc" }
                  });
                  if (deployment) {
                    resolvedCommitSha = deployment.commitSha;
                  }
                }
              }
            }

            // Publish event bus notification
            await EventBus.publish({
              id: generateId("evt"),
              name: "workflow.assertion.failed",
              organizationId: "system",
              projectId: "system",
              environment: "production",
              sourceEntity: "incident-worker",
              commitSha: resolvedCommitSha,
              correlationId: generateCorrelationId(),
              idempotencyKey: generateIdempotencyKey(),
              timestamp: new Date().toISOString(),
              data: { incidentId: incident.id, title: incident.title }
            });

            logger.info({ incidentId: incident.id, resolvedCommitSha }, "Created new Incident and logged alert breach timeline event");

            // Auto-trigger agent investigation
            await prisma.incident.update({
              where: { id: incident.id },
              data: { status: "INVESTIGATING" }
            });

            await prisma.incidentEvent.create({
              data: {
                incidentId: incident.id,
                type: "AGENT_TRIGGERED",
                message: `OpsPilot agent triggered to investigate breach ${rule.metricName}`
              }
            });

            await triggerAgentInvestigation(incident.id, incident.title, metric.serviceId, "production", new Date(metric.timestamp));
            createdIncidents.push(incident);
          }
        }
      }
    }

    res.status(200).json({ status: "success", evaluated: alertRules.length, created: createdIncidents.length });
  } catch (err) {
    next(err);
  }
});

// Global error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error({ err, path: req.path }, "Incident Worker error");
  if (err instanceof OpsPilotError) {
    return res.status(err.statusCode).json({ error: err.code, message: err.message });
  }
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: err.message });
});

const port = 4006;
app.listen(port, () => {
  logger.info(`OpsPilot Incident Worker listening on port ${port}`);
});
