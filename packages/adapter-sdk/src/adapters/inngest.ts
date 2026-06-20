import { OpsPilotAdapter } from "../types.js";
import { AdapterCategory, CapabilityLevel, DetectionResult, ArchitectureContribution } from "@opspilot/schemas";
import fs from "fs";
import path from "path";

export class InngestAdapter extends OpsPilotAdapter {
  readonly id = "inngest";
  readonly name = "Inngest Integration Adapter";
  readonly category: AdapterCategory = "integration";
  readonly capabilityLevel: CapabilityLevel = "RUNTIME";

  async detect(files: string[], rootDir: string): Promise<DetectionResult> {
    const packageJsonFiles = files.filter(f => f.endsWith("package.json"));
    
    for (const pjFile of packageJsonFiles) {
      try {
        const content = await fs.promises.readFile(path.join(rootDir, pjFile), "utf-8");
        const parsed = JSON.parse(content);
        
        const hasInngest = 
          (parsed.dependencies && parsed.dependencies.inngest) || 
          (parsed.devDependencies && parsed.devDependencies.inngest);
          
        if (hasInngest) {
          const version = parsed.dependencies?.inngest || "3.x";
          return {
            detected: true,
            confidence: 1.0,
            version,
            reasons: [`Found Inngest declared in ${pjFile} dependencies`],
            capabilities: ["event_triggers", "durable_functions", "step_verification"]
          };
        }
      } catch {}
    }

    const hasInngestConfig = files.some(f => f.toLowerCase().includes("inngest.json") || f.toLowerCase().includes("inngest.config"));
    if (hasInngestConfig) {
      return {
        detected: true,
        confidence: 0.9,
        reasons: ["Discovered Inngest configuration file in repository"],
        capabilities: ["event_triggers"]
      };
    }

    return {
      detected: false,
      confidence: 0,
      reasons: ["No Inngest indicators found"],
      capabilities: []
    };
  }

  async contributeArchitecture(rootDir: string): Promise<ArchitectureContribution> {
    return {
      nodes: [
        { id: "integration:inngest", type: "external SDK", metadata: { name: "Inngest SDK", domain: "inngest.com" } }
      ],
      edges: []
    };
  }
}
