import dotenv from "dotenv";
dotenv.config();

import { prisma } from "@opspilot/database";
import { config } from "@opspilot/shared";

async function runQualityGate() {
  console.log("=== OpsPilot Release Quality Gate ===");

  try {
    const latestLog = await prisma.auditLog.findFirst({
      where: { action: "evaluation.benchmark.complete" },
      orderBy: { timestamp: "desc" }
    });

    if (!latestLog) {
      const strictGate = config.opspilotMode === "production" || process.env.CI === "true";
      console.error("No benchmark results found in audit logs.");
      process.exit(strictGate ? 1 : 0);
    }

    const payload = latestLog.payload as any;
    console.log(`Model Evaluated: ${payload.model}`);
    console.log(`Evaluated At: ${payload.timestamp}`);
    console.log(`Evaluation Status: ${payload.status}`);

    const m = payload.metrics;
    console.log(`- Retrieval Accuracy: ${(m.retrieval.accuracy * 100).toFixed(0)}%`);
    console.log(`- Agent Accuracy: ${(m.agent.accuracy * 100).toFixed(0)}%`);
    console.log(`- Successful Fix Rate: ${(m.repair.successfulFixRate * 100).toFixed(0)}%`);

    if (payload.status === "REGRESSED") {
      console.error("❌ Quality Gate Failed: Quality regression detected compared to historical baseline!");
      process.exit(1);
    }

    if (m.agent.accuracy < 0.85) {
      console.error(`❌ Quality Gate Failed: Agent accuracy is ${(m.agent.accuracy * 100).toFixed(0)}%, which is below the 85% threshold.`);
      process.exit(1);
    }

    if (m.repair.successfulFixRate < 0.80) {
      console.error(`❌ Quality Gate Failed: Successful Fix Rate is ${(m.repair.successfulFixRate * 100).toFixed(0)}%, which is below the 80% threshold.`);
      process.exit(1);
    }

    console.log("✅ Release Quality Gate Passed Successfully!");
    process.exit(0);
  } catch (err: any) {
    console.error("❌ Quality Gate system error:", err);
    process.exit(1);
  }
}

runQualityGate();
