import { OpsPilotAdapter } from "../types.js";
import { AdapterCategory, CapabilityLevel, DetectionResult, ArchitectureContribution } from "@opspilot/schemas";
import fs from "fs";
import path from "path";

export class BullMQAdapter extends OpsPilotAdapter {
  readonly id = "bullmq";
  readonly name = "BullMQ Queue System Adapter";
  readonly category: AdapterCategory = "messaging";
  readonly capabilityLevel: CapabilityLevel = "RUNTIME";

  async detect(files: string[], rootDir: string): Promise<DetectionResult> {
    const packageJsonFiles = files.filter(f => f.endsWith("package.json"));
    
    for (const pjFile of packageJsonFiles) {
      try {
        const content = await fs.promises.readFile(path.join(rootDir, pjFile), "utf-8");
        const parsed = JSON.parse(content);
        
        const hasBullMQ = 
          (parsed.dependencies && (parsed.dependencies.bullmq || parsed.dependencies.bull)) || 
          (parsed.devDependencies && (parsed.devDependencies.bullmq || parsed.devDependencies.bull));
          
        if (hasBullMQ) {
          const version = parsed.dependencies?.bullmq || parsed.dependencies?.bull || "5.x";
          return {
            detected: true,
            confidence: 1.0,
            version,
            reasons: [`Found BullMQ/Bull declared in ${pjFile} dependencies`],
            capabilities: ["queue_operations", "job_scheduling", "retry_policy"]
          };
        }
      } catch {}
    }

    return {
      detected: false,
      confidence: 0,
      reasons: ["No BullMQ indicators found"],
      capabilities: []
    };
  }

  async contributeArchitecture(rootDir: string): Promise<ArchitectureContribution> {
    return {
      nodes: [
        { id: "queue:bullmq", type: "queue/topic/event", metadata: { name: "BullMQ", broker: "redis" } }
      ],
      edges: [
        { source: "queue:bullmq", target: "cache:redis", type: "DEPENDS_ON" }
      ]
    };
  }
}
