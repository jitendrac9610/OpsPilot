import { OpsPilotAdapter } from "../types.js";
import { AdapterCategory, CapabilityLevel, DetectionResult, ArchitectureContribution } from "@opspilot/schemas";
import fs from "fs";
import path from "path";

export class PostgreSQLAdapter extends OpsPilotAdapter {
  readonly id = "postgres";
  readonly name = "PostgreSQL Database Adapter";
  readonly category: AdapterCategory = "database";
  readonly capabilityLevel: CapabilityLevel = "RUNTIME";

  async detect(files: string[], rootDir: string): Promise<DetectionResult> {
    const packageJsonFiles = files.filter(f => f.endsWith("package.json"));
    
    for (const pjFile of packageJsonFiles) {
      try {
        const content = await fs.promises.readFile(path.join(rootDir, pjFile), "utf-8");
        const parsed = JSON.parse(content);
        
        const hasPG = 
          (parsed.dependencies && (
            parsed.dependencies.pg || 
            parsed.dependencies["pg-promise"] || 
            parsed.dependencies.sequelize || 
            parsed.dependencies.typeorm || 
            parsed.dependencies["@prisma/client"]
          )) || 
          (parsed.devDependencies && (
            parsed.devDependencies.pg || 
            parsed.devDependencies["pg-promise"] || 
            parsed.devDependencies.sequelize || 
            parsed.devDependencies.typeorm || 
            parsed.devDependencies["@prisma/client"]
          ));
          
        if (hasPG) {
          const version = parsed.dependencies?.pg || parsed.dependencies?.["@prisma/client"] || "16.x";
          return {
            detected: true,
            confidence: 1.0,
            version,
            reasons: [`Found PostgreSQL/ORM dependency declared in ${pjFile}`],
            capabilities: ["postgres_queries", "connection_pooling", "schema_validation"]
          };
        }
      } catch {}
    }

    // Fallback: search for schema.prisma or SQL files
    const hasSchemaPrisma = files.some(f => f.endsWith("schema.prisma") || f.endsWith(".sql"));
    if (hasSchemaPrisma) {
      return {
        detected: true,
        confidence: 0.8,
        reasons: ["Discovered Prisma schema or SQL files indicating database usage"],
        capabilities: ["postgres_queries"]
      };
    }

    return {
      detected: false,
      confidence: 0,
      reasons: ["No PostgreSQL indicators found"],
      capabilities: []
    };
  }

  async contributeArchitecture(rootDir: string): Promise<ArchitectureContribution> {
    return {
      nodes: [
        { id: "db:postgres", type: "database", metadata: { name: "PostgreSQL", provider: "native" } }
      ],
      edges: []
    };
  }
}
