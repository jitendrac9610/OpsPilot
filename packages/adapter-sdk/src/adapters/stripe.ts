import { OpsPilotAdapter } from "../types.js";
import { AdapterCategory, CapabilityLevel, DetectionResult, ArchitectureContribution } from "@opspilot/schemas";
import fs from "fs";
import path from "path";

export class StripeAdapter extends OpsPilotAdapter {
  readonly id = "stripe";
  readonly name = "Stripe Integration Adapter";
  readonly category: AdapterCategory = "integration";
  readonly capabilityLevel: CapabilityLevel = "RUNTIME";

  async detect(files: string[], rootDir: string): Promise<DetectionResult> {
    const packageJsonFiles = files.filter(f => f.endsWith("package.json"));
    
    for (const pjFile of packageJsonFiles) {
      try {
        const content = await fs.promises.readFile(path.join(rootDir, pjFile), "utf-8");
        const parsed = JSON.parse(content);
        
        const hasStripe = 
          (parsed.dependencies && parsed.dependencies.stripe) || 
          (parsed.devDependencies && parsed.devDependencies.stripe);
          
        if (hasStripe) {
          const version = parsed.dependencies?.stripe || "14.x";
          return {
            detected: true,
            confidence: 1.0,
            version,
            reasons: [`Found Stripe declared in ${pjFile} dependencies`],
            capabilities: ["payment_flows", "webhook_signature_verification", "billing_portal"]
          };
        }
      } catch {}
    }

    // Fallback: check env file for STRIPE_ keys
    const envFile = files.find(f => f.endsWith(".env") || f.endsWith(".env.local") || f.endsWith(".env.example"));
    if (envFile) {
      try {
        const content = await fs.promises.readFile(path.join(rootDir, envFile), "utf-8");
        if (content.includes("STRIPE_")) {
          return {
            detected: true,
            confidence: 0.9,
            reasons: [`Found Stripe environment variables in ${envFile}`],
            capabilities: ["payment_flows"]
          };
        }
      } catch {}
    }

    return {
      detected: false,
      confidence: 0,
      reasons: ["No Stripe indicators found"],
      capabilities: []
    };
  }

  async contributeArchitecture(rootDir: string): Promise<ArchitectureContribution> {
    return {
      nodes: [
        { id: "integration:stripe", type: "external SDK", metadata: { name: "Stripe", service: "Payments" } }
      ],
      edges: []
    };
  }
}
