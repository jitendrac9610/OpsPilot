import { Router, Response, NextFunction } from "express";
import { prisma } from "@opspilot/database";
import { ValidationError, ForbiddenError } from "@opspilot/shared";
import { authMiddleware, AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

router.use(authMiddleware);

// POST /api/sandboxes
// Initialize a new Sandbox for a repository
router.post("/", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const { repositoryId } = req.body;
    if (!repositoryId) throw new ValidationError("RepositoryId is required");

    // Get the latest snapshot for the repository
    let snapshot = await prisma.repositorySnapshot.findFirst({
      where: { repositoryId },
      orderBy: { createdAt: "desc" }
    });

    if (!snapshot) {
      // Create a mock snapshot if none exists yet (e.g. repository connected but not fully webhook-indexed)
      snapshot = await prisma.repositorySnapshot.create({
        data: {
          repositoryId,
          commitSha: "mock-sha-" + Math.random().toString(36).substring(2, 9),
          archiveUrl: "mock-url"
        }
      });
    }

    // Call Sandbox Controller to allocate workspace
    const response = await fetch("http://localhost:4010/api/sandboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshotId: snapshot.id })
    });

    if (!response.ok) {
      throw new Error(`Failed to initialize sandbox in controller: ${await response.text()}`);
    }

    const sbData = await response.json();
    const sandboxId = sbData.id;

    // Create sandbox service records in database so the UI can list them
    const services = ["api-service", "web-service", "mongodb", "redis", "inngest"];
    const serviceRecords = [];
    for (let i = 0; i < services.length; i++) {
      const s = await prisma.sandboxService.create({
        data: {
          sandboxId,
          name: services[i],
          port: 4000 + i,
          status: "RUNNING"
        }
      });
      serviceRecords.push(s);
    }

    // Add Audit Log
    const repo = await prisma.repository.findUnique({ where: { id: repositoryId } });
    await prisma.auditLog.create({
      data: {
        orgId: req.organizationId || "",
        userId: req.user!.id,
        action: "sandbox.create",
        payload: { sandboxId, repositoryId, repoName: repo?.name || "" }
      }
    });

    // Increment billing usage (sandbox minutes)
    await prisma.usageRecord.create({
      data: {
        orgId: req.organizationId || "",
        dimension: "sandbox_minutes",
        quantity: 15
      }
    });

    res.status(201).json({
      id: sandboxId,
      status: "READY",
      services: serviceRecords
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/sandboxes/:id
// Get sandbox state, service list, recent build/test runs
router.get("/:id", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const sandboxId = req.params.id;

    const sandbox = await prisma.sandbox.findUnique({
      where: { id: sandboxId }
    });

    if (!sandbox) {
      return res.status(404).json({ error: "Sandbox not found" });
    }

    const services = await prisma.sandboxService.findMany({
      where: { sandboxId }
    });

    const testRuns = await prisma.testRun.findMany({
      where: { sandboxId },
      orderBy: { createdAt: "desc" }
    });

    const loadRuns = await prisma.loadTestRun.findMany({
      where: { sandboxId },
      orderBy: { createdAt: "desc" }
    });

    const failures = await prisma.failureInjection.findMany({
      where: { sandboxId },
      orderBy: { createdAt: "desc" }
    });

    res.json({
      ...sandbox,
      services,
      testRuns,
      loadRuns,
      failures
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/sandboxes/:id/test
// Execute unit or E2E tests in the sandbox
router.post("/:id/test", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const sandboxId = req.params.id;
    const { type } = req.body; // e.g. "unit" or "e2e"

    // Call Sandbox Controller
    const response = await fetch(`http://localhost:4010/api/sandboxes/${sandboxId}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, command: type === "unit" ? "npm test" : "npm run test:e2e" })
    });

    const result = await response.json();

    // Log the test run in database
    const testRun = await prisma.testRun.create({
      data: {
        sandboxId,
        type: type || "unit",
        success: result.success || false,
        log: result.log || result.logs || JSON.stringify(result)
      }
    });

    res.json(testRun);
  } catch (err) {
    next(err);
  }
});

// POST /api/sandboxes/:id/inject-failure
// Inject failure (latency or crash)
router.post("/:id/inject-failure", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const sandboxId = req.params.id;
    const { type, serviceName, config } = req.body;

    // Log in database
    const injection = await prisma.failureInjection.create({
      data: {
        sandboxId,
        type: type || "latency",
        config: config || { latencyMs: 2000, targetService: serviceName || "api-service" }
      }
    });

    // Update service status to denote simulation
    if (type === "crash") {
      await prisma.sandboxService.updateMany({
        where: { sandboxId, name: serviceName || "api-service" },
        data: { status: "CRASHED" }
      });
    }

    res.json(injection);
  } catch (err) {
    next(err);
  }
});

// POST /api/sandboxes/:id/load-test
// Generate load test metrics
router.post("/:id/load-test", async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const sandboxId = req.params.id;

    // Simulate high load metrics
    const loadRun = await prisma.loadTestRun.create({
      data: {
        sandboxId,
        throughput: 150 + Math.random() * 50,
        latencyP95: 120 + Math.random() * 80,
        errorRate: Math.random() * 0.02
      }
    });

    res.json(loadRun);
  } catch (err) {
    next(err);
  }
});

export const sandboxRouter: Router = router;
