import { OpsPilotAdapter } from "../types.js";
import { AdapterCategory, CapabilityLevel, DetectionResult, ArchitectureContribution } from "@opspilot/schemas";
import fs from "fs";
import path from "path";

export class RedisAdapter extends OpsPilotAdapter {
  readonly id = "redis";
  readonly name = "Redis Cache Adapter";
  readonly category: AdapterCategory = "messaging";
  readonly capabilityLevel: CapabilityLevel = "RUNTIME";

  async detect(files: string[], rootDir: string): Promise<DetectionResult> {
    const packageJsonFiles = files.filter(f => f.endsWith("package.json"));
    
    for (const pjFile of packageJsonFiles) {
      try {
        const content = await fs.promises.readFile(path.join(rootDir, pjFile), "utf-8");
        const parsed = JSON.parse(content);
        
        const hasRedis = 
          (parsed.dependencies && (parsed.dependencies.redis || parsed.dependencies.ioredis)) || 
          (parsed.devDependencies && (parsed.devDependencies.redis || parsed.devDependencies.ioredis));
          
        if (hasRedis) {
          const version = parsed.dependencies?.ioredis || parsed.dependencies?.redis || "7.x";
          return {
            detected: true,
            confidence: 1.0,
            version,
            reasons: [`Found Redis client dependency in ${pjFile}`],
            capabilities: ["cache_operations", "key_expiration", "pubsub"]
          };
        }
      } catch {}
    }

    const hasRedisConf = files.some(f => f.toLowerCase().includes("redis.conf") || f.toLowerCase().includes("redis.json"));
    if (hasRedisConf) {
      return {
        detected: true,
        confidence: 0.9,
        reasons: ["Discovered redis configuration files in workspace"],
        capabilities: ["cache_operations"]
      };
    }

    return {
      detected: false,
      confidence: 0,
      reasons: ["No Redis indicators found"],
      capabilities: []
    };
  }

  async contributeArchitecture(rootDir: string): Promise<ArchitectureContribution> {
    return {
      nodes: [
        { id: "cache:redis", type: "cache", metadata: { name: "Redis Cache", provider: "native" } }
      ],
      edges: []
    };
  }
}
