import dotenv from "dotenv";
dotenv.config();

import { prisma } from "@opspilot/database";
import { execSync } from "child_process";

async function testQualityGate() {
  console.log("=== Testing Quality Gate Assertions ===");
  
  // Clean up any test logs
  await prisma.auditLog.deleteMany({
    where: { orgId: "test-org-123" }
  });

  const runQualityGateCmd = (extraEnv: Record<string, string> = {}) => {
    try {
      execSync("npx tsx scripts/quality-gate.ts", {
        stdio: "inherit",
        env: { ...process.env, ...extraEnv }
      });
      return 0;
    } catch (err: any) {
      return err.status !== undefined ? err.status : 1;
    }
  };

  // Scenario 1: No log in DB at all (for this run we can clean everything matching action)
  const originalLogs = await prisma.auditLog.findMany({
    where: { action: "evaluation.benchmark.complete" }
  });
  
  await prisma.auditLog.deleteMany({
    where: { action: "evaluation.benchmark.complete" }
  });

  console.log("\n--- Scenario 1: No Benchmark Logs ---");
  const exitCode1 = runQualityGateCmd();
  console.log(`Exit code (Expected 0): ${exitCode1}`);
  if (exitCode1 !== 0) throw new Error("Scenario 1 failed");

  console.log("\n--- Scenario 1b: No Benchmark Logs In CI ---");
  const exitCode1b = runQualityGateCmd({ CI: "true" });
  console.log(`Exit code (Expected 1): ${exitCode1b}`);
  if (exitCode1b !== 1) throw new Error("Scenario 1b failed");

  // Scenario 2: Successful Benchmark Log
  console.log("\n--- Scenario 2: Successful Benchmark Log ---");
  await prisma.auditLog.create({
    data: {
      orgId: "test-org-123",
      action: "evaluation.benchmark.complete",
      payload: {
        model: "gemini-1.5-flash",
        timestamp: new Date().toISOString(),
        status: "PASSED",
        metrics: {
          retrieval: { accuracy: 0.95 },
          agent: { accuracy: 0.90 },
          repair: { successfulFixRate: 0.85 }
        }
      }
    }
  });
  const exitCode2 = runQualityGateCmd();
  console.log(`Exit code (Expected 0): ${exitCode2}`);
  if (exitCode2 !== 0) throw new Error("Scenario 2 failed");

  // Scenario 3: Regressed status
  console.log("\n--- Scenario 3: Regressed status ---");
  await prisma.auditLog.create({
    data: {
      orgId: "test-org-123",
      action: "evaluation.benchmark.complete",
      payload: {
        model: "gemini-1.5-flash",
        timestamp: new Date().toISOString(),
        status: "REGRESSED",
        metrics: {
          retrieval: { accuracy: 0.95 },
          agent: { accuracy: 0.90 },
          repair: { successfulFixRate: 0.85 }
        }
      }
    }
  });
  const exitCode3 = runQualityGateCmd();
  console.log(`Exit code (Expected 1): ${exitCode3}`);
  if (exitCode3 !== 1) throw new Error("Scenario 3 failed");

  // Scenario 4: Agent score below threshold (agent accuracy < 85%)
  console.log("\n--- Scenario 4: Agent score below threshold ---");
  await prisma.auditLog.create({
    data: {
      orgId: "test-org-123",
      action: "evaluation.benchmark.complete",
      payload: {
        model: "gemini-1.5-flash",
        timestamp: new Date().toISOString(),
        status: "PASSED",
        metrics: {
          retrieval: { accuracy: 0.95 },
          agent: { accuracy: 0.80 },
          repair: { successfulFixRate: 0.85 }
        }
      }
    }
  });
  const exitCode4 = runQualityGateCmd();
  console.log(`Exit code (Expected 1): ${exitCode4}`);
  if (exitCode4 !== 1) throw new Error("Scenario 4 failed");

  // Scenario 5: Repair score below threshold (successfulFixRate < 80%)
  console.log("\n--- Scenario 5: Repair score below threshold ---");
  await prisma.auditLog.create({
    data: {
      orgId: "test-org-123",
      action: "evaluation.benchmark.complete",
      payload: {
        model: "gemini-1.5-flash",
        timestamp: new Date().toISOString(),
        status: "PASSED",
        metrics: {
          retrieval: { accuracy: 0.95 },
          agent: { accuracy: 0.90 },
          repair: { successfulFixRate: 0.75 }
        }
      }
    }
  });
  const exitCode5 = runQualityGateCmd();
  console.log(`Exit code (Expected 1): ${exitCode5}`);
  if (exitCode5 !== 1) throw new Error("Scenario 5 failed");

  // Restore original logs
  await prisma.auditLog.deleteMany({
    where: { action: "evaluation.benchmark.complete" }
  });
  for (const log of originalLogs) {
    await prisma.auditLog.create({
      data: {
        orgId: log.orgId,
        action: log.action,
        payload: log.payload as any,
        timestamp: log.timestamp
      }
    });
  }

  console.log("\n🎉 ALL QUALITY GATE SCENARIO TESTS PASSED!");
}

testQualityGate().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
