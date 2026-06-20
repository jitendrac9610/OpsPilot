import { OpsPilotAdapter } from "../types.js";
import { AdapterCategory, CapabilityLevel, DetectionResult, ArchitectureContribution } from "@opspilot/schemas";
import fs from "fs";
import path from "path";

export class NodeAdapter extends OpsPilotAdapter {
  readonly id = "node";
  readonly name = "Node.js Runtime Adapter";
  readonly category: AdapterCategory = "runtime";
  readonly capabilityLevel: CapabilityLevel = "RUNTIME";

  async detect(files: string[], rootDir: string): Promise<DetectionResult> {
    const hasPackageJson = files.some(f => f.endsWith("package.json"));

    if (hasPackageJson) {
      // Try parsing engines field
      let version = "18.x";
      try {
        const pjPath = files.find(f => f.endsWith("package.json"));
        if (pjPath) {
          const content = await fs.promises.readFile(path.join(rootDir, pjPath), "utf-8");
          const parsed = JSON.parse(content);
          if (parsed.engines && parsed.engines.node) {
            version = parsed.engines.node;
          }
        }
      } catch {}

      return {
        detected: true,
        confidence: 1.0,
        version,
        reasons: ["Discovered package.json file signifying a Node.js project environment"],
        capabilities: ["package_management", "process_execution", "npm_scripts"]
      };
    }

    return {
      detected: false,
      confidence: 0,
      reasons: ["No package.json file found"],
      capabilities: []
    };
  }

  async contributeArchitecture(rootDir: string): Promise<ArchitectureContribution> {
    return {
      nodes: [
        { id: "runtime:node", type: "runtime", metadata: { name: "Node.js" } }
      ],
      edges: []
    };
  }
}
