import { OpsPilotAdapter } from "../types.js";
import { AdapterCategory, CapabilityLevel, DetectionResult, ArchitectureContribution } from "@opspilot/schemas";
import fs from "fs";
import path from "path";

export class MongoDBAdapter extends OpsPilotAdapter {
  readonly id = "mongodb";
  readonly name = "MongoDB Database Adapter";
  readonly category: AdapterCategory = "database";
  readonly capabilityLevel: CapabilityLevel = "RUNTIME";

  async detect(files: string[], rootDir: string): Promise<DetectionResult> {
    const packageJsonFiles = files.filter(f => f.endsWith("package.json"));
    
    for (const pjFile of packageJsonFiles) {
      try {
        const content = await fs.promises.readFile(path.join(rootDir, pjFile), "utf-8");
        const parsed = JSON.parse(content);
        
        const hasMongo = 
          (parsed.dependencies && (parsed.dependencies.mongodb || parsed.dependencies.mongoose)) || 
          (parsed.devDependencies && (parsed.devDependencies.mongodb || parsed.devDependencies.mongoose));
          
        if (hasMongo) {
          const version = parsed.dependencies?.mongoose || parsed.dependencies?.mongodb || parsed.devDependencies?.mongoose || parsed.devDependencies?.mongodb || "7.x";
          return {
            detected: true,
            confidence: 1.0,
            version,
            reasons: [`Found MongoDB/Mongoose declared in ${pjFile} dependencies`],
            capabilities: ["mongodb_queries", "schema_validation", "indexing_checks"]
          };
        }
      } catch {}
    }

    // Fallback check for files/directories
    const hasMongoFiles = files.some(f => f.toLowerCase().includes("mongodb") || f.toLowerCase().includes("mongoose"));
    if (hasMongoFiles) {
      return {
        detected: true,
        confidence: 0.8,
        reasons: ["Discovered files or directories referencing MongoDB or Mongoose"],
        capabilities: ["mongodb_queries"]
      };
    }

    return {
      detected: false,
      confidence: 0,
      reasons: ["No MongoDB or Mongoose indicators found"],
      capabilities: []
    };
  }

  async contributeArchitecture(rootDir: string): Promise<ArchitectureContribution> {
    return {
      nodes: [
        { id: "db:mongodb", type: "database", metadata: { name: "MongoDB", provider: "native" } }
      ],
      edges: []
    };
  }
}
