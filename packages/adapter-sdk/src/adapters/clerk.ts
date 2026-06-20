import { OpsPilotAdapter } from "../types.js";
import { AdapterCategory, CapabilityLevel, DetectionResult, ArchitectureContribution } from "@opspilot/schemas";
import fs from "fs";
import path from "path";

export class ClerkAdapter extends OpsPilotAdapter {
  readonly id = "clerk";
  readonly name = "Clerk Integration Adapter";
  readonly category: AdapterCategory = "integration";
  readonly capabilityLevel: CapabilityLevel = "RUNTIME";

  async detect(files: string[], rootDir: string): Promise<DetectionResult> {
    const packageJsonFiles = files.filter(f => f.endsWith("package.json"));
    
    for (const pjFile of packageJsonFiles) {
      try {
        const content = await fs.promises.readFile(path.join(rootDir, pjFile), "utf-8");
        const parsed = JSON.parse(content);
        
        const dependencies = { ...parsed.dependencies, ...parsed.devDependencies };
        const hasClerk = Object.keys(dependencies).some(dep => dep.startsWith("@clerk/"));
        
        if (hasClerk) {
          const clerkDep = Object.keys(dependencies).find(dep => dep.startsWith("@clerk/"));
          const version = dependencies[clerkDep!] || "5.x";
          return {
            detected: true,
            confidence: 1.0,
            version,
            reasons: [`Found Clerk SDK dependency '${clerkDep}' in ${pjFile}`],
            capabilities: ["identity_verification", "session_management", "token_validation"]
          };
        }
      } catch {}
    }

    // Fallback: check env file for CLERK_ keys
    const envFile = files.find(f => f.endsWith(".env") || f.endsWith(".env.local") || f.endsWith(".env.example"));
    if (envFile) {
      try {
        const content = await fs.promises.readFile(path.join(rootDir, envFile), "utf-8");
        if (content.includes("CLERK_")) {
          return {
            detected: true,
            confidence: 0.9,
            reasons: [`Found Clerk environment variables in ${envFile}`],
            capabilities: ["identity_verification"]
          };
        }
      } catch {}
    }

    return {
      detected: false,
      confidence: 0,
      reasons: ["No Clerk indicators found"],
      capabilities: []
    };
  }

  async contributeArchitecture(rootDir: string): Promise<ArchitectureContribution> {
    return {
      nodes: [
        { id: "integration:clerk", type: "external SDK", metadata: { name: "Clerk", service: "Auth" } }
      ],
      edges: []
    };
  }
}
