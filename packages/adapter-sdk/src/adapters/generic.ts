import { OpsPilotAdapter } from "../types.js";
import { AdapterCategory, CapabilityLevel, DetectionResult, ArchitectureContribution } from "@opspilot/schemas";
import path from "path";

export class GenericFallbackAdapter extends OpsPilotAdapter {
  readonly id = "generic";
  readonly name = "Generic Technology Adapter";
  readonly category: AdapterCategory = "language";
  readonly capabilityLevel: CapabilityLevel = "GENERIC";

  async detect(files: string[], rootDir: string): Promise<DetectionResult> {
    // If files list is not empty, report generic files detection
    if (files.length > 0) {
      // Find list of extensions in the file list
      const extensions = Array.from(new Set(
        files.map(f => path.extname(f)).filter(ext => ext.length > 0)
      ));
      
      return {
        detected: true,
        confidence: 0.5,
        reasons: [`Discovered raw source files with extensions: ${extensions.join(", ")}`],
        capabilities: ["raw_lexical_chunks", "unparsed_sources"]
      };
    }

    return {
      detected: false,
      confidence: 0,
      reasons: ["Empty repository files list"],
      capabilities: []
    };
  }

  async contributeArchitecture(rootDir: string): Promise<ArchitectureContribution> {
    return {
      nodes: [
        { id: "lang:generic", type: "language", metadata: { name: "Unknown/Generic" } }
      ],
      edges: []
    };
  }
}
