"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const bullmq_1 = require("bullmq");
const shared_1 = require("@opspilot/shared");
const database_1 = require("@opspilot/database");
const app = (0, express_1.default)();
app.use(express_1.default.json());
const QUEUE_NAME = "agent-runs";
// Helper to enqueue agent investigation
async function triggerAgentInvestigation(incidentId, title) {
    try {
        const redisUrl = new URL(shared_1.config.redisUrl);
        const connection = {
            host: redisUrl.hostname || "127.0.0.1",
            port: parseInt(redisUrl.port || "6379", 10),
            username: redisUrl.username || undefined,
            password: redisUrl.password || undefined,
            db: parseInt(redisUrl.pathname.replace("/", "") || "0", 10)
        };
        const agentQueue = new bullmq_1.Queue(QUEUE_NAME, { connection });
        // We fetch a default snapshotId to link the agent run to code, if it exists
        const latestSnapshot = await database_1.prisma.repositorySnapshot.findFirst({
            orderBy: { createdAt: "desc" }
        });
        const job = await agentQueue.add("investigate-incident", {
            agentRunId: `run_${(0, shared_1.generateId)()}`,
            incidentId,
            snapshotId: latestSnapshot?.id || "mock-snapshot-id",
            goal: `Investigate and remediate the production incident: ${title}`,
            isProduction: true
        });
        shared_1.logger.info({ jobId: job.id, incidentId }, "Enqueued AI Agent investigation job on BullMQ queue");
    }
    catch (err) {
        shared_1.logger.warn({ err: err.message, incidentId }, "Redis/BullMQ not available. Incident Worker skipping agent job enqueuing.");
    }
}
// POST /evaluate
app.post("/evaluate", async (req, res, next) => {
    try {
        shared_1.logger.info("Starting alert rule evaluation...");
        // 1. Fetch alert rules
        const alertRules = await database_1.prisma.alertRule.findMany();
        if (alertRules.length === 0) {
            return res.status(200).json({ status: "success", message: "No alert rules defined. Skipping." });
        }
        // 2. Query ingested metrics from Telemetry API
        const metricsResponse = await fetch("http://localhost:4005/v1/metrics");
        if (!metricsResponse.ok) {
            throw new Error(`Failed to query Telemetry API: ${metricsResponse.statusText}`);
        }
        const metrics = await metricsResponse.json();
        // 3. Evaluate breaches
        const createdIncidents = [];
        for (const rule of alertRules) {
            // Find metrics matching rule.metricName
            const matchingMetrics = metrics.filter(m => m.metricName === rule.metricName);
            for (const metric of matchingMetrics) {
                if (metric.value > rule.threshold) {
                    // Breach detected! Grouping/Deduplication check:
                    // Check if an active incident for this metric breach already exists
                    const existingIncident = await database_1.prisma.incident.findFirst({
                        where: {
                            title: `Breach: ${rule.metricName} exceeded ${rule.threshold}`,
                            status: { in: ["PENDING", "INVESTIGATING", "NEEDS_HUMAN"] }
                        }
                    });
                    if (existingIncident) {
                        // Deduplicate: append event to existing incident timeline
                        await database_1.prisma.incidentEvent.create({
                            data: {
                                incidentId: existingIncident.id,
                                type: "METRIC_BREACH_REPEAT",
                                message: `Repeat breach: ${metric.metricName} is currently ${metric.value} (threshold ${rule.threshold})`
                            }
                        });
                        shared_1.logger.info({ incidentId: existingIncident.id }, "Breach detected. Deduplicated and grouped to existing active incident");
                    }
                    else {
                        // Create a new incident
                        const incident = await database_1.prisma.incident.create({
                            data: {
                                title: `Breach: ${rule.metricName} exceeded ${rule.threshold}`,
                                severity: "HIGH",
                                status: "PENDING"
                            }
                        });
                        // Log breach event on timeline
                        await database_1.prisma.incidentEvent.create({
                            data: {
                                incidentId: incident.id,
                                type: "METRIC_BREACH",
                                message: `Threshold breached: ${metric.metricName} reached ${metric.value} (threshold ${rule.threshold})`
                            }
                        });
                        // Map incident to service if available
                        if (metric.serviceId) {
                            await database_1.prisma.incidentService.create({
                                data: {
                                    incidentId: incident.id,
                                    serviceId: metric.serviceId
                                }
                            });
                        }
                        // Publish event bus notification
                        await shared_1.EventBus.publish({
                            id: (0, shared_1.generateId)("evt"),
                            name: "workflow.assertion.failed",
                            organizationId: "system",
                            projectId: "system",
                            environment: "production",
                            sourceEntity: "incident-worker",
                            commitSha: "latest",
                            correlationId: (0, shared_1.generateCorrelationId)(),
                            idempotencyKey: (0, shared_1.generateIdempotencyKey)(),
                            timestamp: new Date().toISOString(),
                            data: { incidentId: incident.id, title: incident.title }
                        });
                        shared_1.logger.info({ incidentId: incident.id }, "Created new Incident and logged alert breach timeline event");
                        // Auto-trigger agent investigation
                        await database_1.prisma.incident.update({
                            where: { id: incident.id },
                            data: { status: "INVESTIGATING" }
                        });
                        await database_1.prisma.incidentEvent.create({
                            data: {
                                incidentId: incident.id,
                                type: "AGENT_TRIGGERED",
                                message: `OpsPilot agent triggered to investigate breach ${rule.metricName}`
                            }
                        });
                        await triggerAgentInvestigation(incident.id, incident.title);
                        createdIncidents.push(incident);
                    }
                }
            }
        }
        res.status(200).json({ status: "success", evaluated: alertRules.length, created: createdIncidents.length });
    }
    catch (err) {
        next(err);
    }
});
// Global error handler
app.use((err, req, res, next) => {
    shared_1.logger.error({ err, path: req.path }, "Incident Worker error");
    if (err instanceof shared_1.OpsPilotError) {
        return res.status(err.statusCode).json({ error: err.code, message: err.message });
    }
    res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: err.message });
});
const port = 4006;
app.listen(port, () => {
    shared_1.logger.info(`OpsPilot Incident Worker listening on port ${port}`);
});
//# sourceMappingURL=index.js.map