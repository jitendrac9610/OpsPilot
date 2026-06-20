import { OpsPilotAdapter } from "../types.js";
import { AdapterCategory, CapabilityLevel, DetectionResult, ArchitectureContribution } from "@opspilot/schemas";
import fs from "fs";
import path from "path";

export class GetStreamAdapter extends OpsPilotAdapter {
  readonly id = "getstream";
  readonly name = "GetStream Integration Adapter";
  readonly category: AdapterCategory = "integration";
  readonly capabilityLevel: CapabilityLevel = "RUNTIME";

  async detect(files: string[], rootDir: string): Promise<DetectionResult> {
    const packageJsonFiles = files.filter(f => f.endsWith("package.json"));
    
    for (const pjFile of packageJsonFiles) {
      try {
        const content = await fs.promises.readFile(path.join(rootDir, pjFile), "utf-8");
        const parsed = JSON.parse(content);
        
        const dependencies = { ...parsed.dependencies, ...parsed.devDependencies };
        const hasGetStream = Object.keys(dependencies).some(dep => 
          dep === "getstream" || dep === "stream-chat" || dep.startsWith("@stream-io/")
        );
        
        if (hasGetStream) {
          const streamDep = Object.keys(dependencies).find(dep => 
            dep === "getstream" || dep === "stream-chat" || dep.startsWith("@stream-io/")
          );
          const version = dependencies[streamDep!] || "8.x";
          return {
            detected: true,
            confidence: 1.0,
            version,
            reasons: [`Found GetStream dependency '${streamDep}' in ${pjFile}`],
            capabilities: ["video_chat_rooms", "token_generation", "webhook_sync"]
          };
        }
      } catch {}
    }

    const envFile = files.find(f => f.endsWith(".env") || f.endsWith(".env.local") || f.endsWith(".env.example"));
    if (envFile) {
      try {
        const content = await fs.promises.readFile(path.join(rootDir, envFile), "utf-8");
        if (content.includes("STREAM_")) {
          return {
            detected: true,
            confidence: 0.9,
            reasons: [`Found GetStream environment variables in ${envFile}`],
            capabilities: ["video_chat_rooms"]
          };
        }
      } catch {}
    }

    return {
      detected: false,
      confidence: 0,
      reasons: ["No GetStream indicators found"],
      capabilities: []
    };
  }

  async contributeArchitecture(rootDir: string): Promise<ArchitectureContribution> {
    return {
      nodes: [
        { id: "integration:getstream", type: "external SDK", metadata: { name: "GetStream", service: "Video/Chat" } }
      ],
      edges: []
    };
  }
}
