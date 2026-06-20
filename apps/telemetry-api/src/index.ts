import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { logger, config, OpsPilotError } from "@opspilot/shared";

const app = express();
app.use(cors());
app.use(express.json());

// In-memory telemetry stores
export interface MetricData {
  serviceId: string;
  metricName: string;
  value: number;
  timestamp: string;
}

export interface LogData {
  serviceId: string;
  message: string;
  level: string;
  timestamp: string;
}

export interface TraceData {
  serviceId: string;
  traceId: string;
  spanId: string;
  name: string;
  exception?: string;
  timestamp: string;
}

export interface EventData {
  serviceId: string;
  type: string;
  message: string;
  timestamp: string;
}

const metricsStore: MetricData[] = [];
const logsStore: LogData[] = [];
const tracesStore: TraceData[] = [];
const eventsStore: EventData[] = [];

// Helper to trigger evaluation in incident-worker
async function triggerIncidentEvaluation() {
  try {
    await fetch("http://localhost:4006/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
  } catch (err: any) {
    logger.warn({ err: err.message }, "Telemetry API failed to notify Incident Worker evaluation");
  }
}

// Ingestion endpoints
app.post("/v1/metrics", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serviceId, metricName, value, timestamp } = req.body;
    if (!serviceId || !metricName || value === undefined) {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: "serviceId, metricName, and value are required" });
    }

    const metric: MetricData = {
      serviceId,
      metricName,
      value,
      timestamp: timestamp || new Date().toISOString()
    };
    metricsStore.push(metric);
    logger.info({ metric }, "Metric telemetry ingested");

    // Async trigger evaluation
    triggerIncidentEvaluation();

    res.status(202).json({ status: "success", message: "Metric ingested" });
  } catch (err) {
    next(err);
  }
});

app.post("/v1/logs", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serviceId, message, level, timestamp } = req.body;
    if (!serviceId || !message || !level) {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: "serviceId, message, and level are required" });
    }

    const log: LogData = {
      serviceId,
      message,
      level,
      timestamp: timestamp || new Date().toISOString()
    };
    logsStore.push(log);
    logger.info({ log }, "Log telemetry ingested");

    triggerIncidentEvaluation();

    res.status(202).json({ status: "success", message: "Log ingested" });
  } catch (err) {
    next(err);
  }
});

app.post("/v1/traces", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serviceId, traceId, spanId, name, exception, timestamp } = req.body;
    if (!serviceId || !traceId || !spanId || !name) {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: "serviceId, traceId, spanId, and name are required" });
    }

    const trace: TraceData = {
      serviceId,
      traceId,
      spanId,
      name,
      exception,
      timestamp: timestamp || new Date().toISOString()
    };
    tracesStore.push(trace);
    logger.info({ trace }, "Trace telemetry ingested");

    triggerIncidentEvaluation();

    res.status(202).json({ status: "success", message: "Trace ingested" });
  } catch (err) {
    next(err);
  }
});

app.post("/v1/events", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { serviceId, type, message, timestamp } = req.body;
    if (!serviceId || !type || !message) {
      return res.status(400).json({ error: "VALIDATION_ERROR", message: "serviceId, type, and message are required" });
    }

    const event: EventData = {
      serviceId,
      type,
      message,
      timestamp: timestamp || new Date().toISOString()
    };
    eventsStore.push(event);
    logger.info({ event }, "Event telemetry ingested");

    triggerIncidentEvaluation();

    res.status(202).json({ status: "success", message: "Event ingested" });
  } catch (err) {
    next(err);
  }
});

// Query endpoints for Incident Worker & Tests
app.get("/v1/metrics", (req: Request, res: Response) => {
  res.status(200).json(metricsStore);
});

app.get("/v1/logs", (req: Request, res: Response) => {
  res.status(200).json(logsStore);
});

app.get("/v1/traces", (req: Request, res: Response) => {
  res.status(200).json(tracesStore);
});

app.get("/v1/events", (req: Request, res: Response) => {
  res.status(200).json(eventsStore);
});

app.delete("/v1/clear", (req: Request, res: Response) => {
  metricsStore.length = 0;
  logsStore.length = 0;
  tracesStore.length = 0;
  eventsStore.length = 0;
  res.status(200).json({ status: "success", message: "Stores cleared" });
});

// Global error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error({ err, path: req.path }, "Telemetry API error occurred");
  if (err instanceof OpsPilotError) {
    return res.status(err.statusCode).json({ error: err.code, message: err.message });
  }
  res.status(500).json({ error: "INTERNAL_SERVER_ERROR", message: err.message });
});

const port = 4005;
app.listen(port, () => {
  logger.info(`OpsPilot Telemetry API listening on port ${port}`);
});
