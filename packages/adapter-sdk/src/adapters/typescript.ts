import { OpsPilotAdapter } from "../types.js";
import { AdapterCategory, CapabilityLevel, DetectionResult, ArchitectureContribution } from "@opspilot/schemas";

export class TypeScriptAdapter extends OpsPilotAdapter {
  readonly id = "typescript";
  readonly name = "TypeScript/JavaScript Adapter";
  readonly category: AdapterCategory = "language";
  readonly capabilityLevel: CapabilityLevel = "SEMANTIC";

  async detect(files: string[], rootDir: string): Promise<DetectionResult> {
    const hasTSJS = files.some(f => 
      f.endsWith(".ts") || 
      f.endsWith(".tsx") || 
      f.endsWith(".js") || 
      f.endsWith(".jsx")
    );

    if (hasTSJS) {
      return {
        detected: true,
        confidence: 1.0,
        reasons: ["Discovered files ending with TypeScript/JavaScript extensions (.ts, .tsx, .js, .jsx)"],
        capabilities: ["static_analysis", "syntax_linting", "ast_parsing"]
      };
    }

    return {
      detected: false,
      confidence: 0,
      reasons: ["No TypeScript/JavaScript files found"],
      capabilities: []
    };
  }

  async contributeArchitecture(rootDir: string): Promise<ArchitectureContribution> {
    return {
      nodes: [
        { id: "lang:typescript", type: "language", metadata: { name: "TypeScript", version: "5.x" } }
      ],
      edges: []
    };
  }
}
