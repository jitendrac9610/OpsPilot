import { OpsPilotAdapter } from "../types.js";
import { AdapterCategory, CapabilityLevel, DetectionResult, ArchitectureContribution } from "@opspilot/schemas";
import fs from "fs";
import path from "path";

export class NextAdapter extends OpsPilotAdapter {
  readonly id = "next";
  readonly name = "Next.js Framework Adapter";
  readonly category: AdapterCategory = "framework";
  readonly capabilityLevel: CapabilityLevel = "SEMANTIC";

  async detect(files: string[], rootDir: string): Promise<DetectionResult> {
    const packageJsonFiles = files.filter(f => f.endsWith("package.json"));
    
    for (const pjFile of packageJsonFiles) {
      try {
        const content = await fs.promises.readFile(path.join(rootDir, pjFile), "utf-8");
        const parsed = JSON.parse(content);
        
        const hasNext = 
          (parsed.dependencies && parsed.dependencies.next) || 
          (parsed.devDependencies && parsed.devDependencies.next);
          
        if (hasNext) {
          return {
            detected: true,
            confidence: 1.0,
            version: parsed.dependencies?.next || parsed.devDependencies?.next || "14.x",
            reasons: [`Found 'next' declared in ${pjFile} dependencies`],
            capabilities: ["react_components", "server_actions", "hybrid_routing"]
          };
        }
      } catch {}
    }

    return {
      detected: false,
      confidence: 0,
      reasons: ["No 'next' dependency found in package manifests"],
      capabilities: []
    };
  }

  async contributeArchitecture(rootDir: string): Promise<ArchitectureContribution> {
    return {
      nodes: [
        { id: "fw:next", type: "framework", metadata: { name: "Next.js" } }
      ],
      edges: []
    };
  }
}
