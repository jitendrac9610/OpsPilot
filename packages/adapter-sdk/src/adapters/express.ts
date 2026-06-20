import { OpsPilotAdapter } from "../types.js";
import { AdapterCategory, CapabilityLevel, DetectionResult, ArchitectureContribution } from "@opspilot/schemas";
import fs from "fs";
import path from "path";

export class ExpressAdapter extends OpsPilotAdapter {
  readonly id = "express";
  readonly name = "Express Framework Adapter";
  readonly category: AdapterCategory = "framework";
  readonly capabilityLevel: CapabilityLevel = "SEMANTIC";

  async detect(files: string[], rootDir: string): Promise<DetectionResult> {
    const packageJsonFiles = files.filter(f => f.endsWith("package.json"));
    
    for (const pjFile of packageJsonFiles) {
      try {
        const content = await fs.promises.readFile(path.join(rootDir, pjFile), "utf-8");
        const parsed = JSON.parse(content);
        
        const hasExpress = 
          (parsed.dependencies && parsed.dependencies.express) || 
          (parsed.devDependencies && parsed.devDependencies.express);
          
        if (hasExpress) {
          return {
            detected: true,
            confidence: 1.0,
            version: parsed.dependencies?.express || parsed.devDependencies?.express || "4.x",
            reasons: [`Found 'express' declared in ${pjFile} dependencies`],
            capabilities: ["http_routes", "request_middleware", "server_side_routing"]
          };
        }
      } catch {}
    }

    return {
      detected: false,
      confidence: 0,
      reasons: ["No 'express' dependency found in package manifests"],
      capabilities: []
    };
  }

  async contributeArchitecture(rootDir: string): Promise<ArchitectureContribution> {
    return {
      nodes: [
        { id: "fw:express", type: "framework", metadata: { name: "Express" } }
      ],
      edges: []
    };
  }
}
