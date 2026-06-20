import { OpsPilotAdapter } from "../types.js";
import { AdapterCategory, CapabilityLevel, DetectionResult, ArchitectureContribution } from "@opspilot/schemas";
import fs from "fs";
import path from "path";

export class KubernetesAdapter extends OpsPilotAdapter {
  readonly id = "kubernetes";
  readonly name = "Kubernetes Deployment Adapter";
  readonly category: AdapterCategory = "deployment";
  readonly capabilityLevel: CapabilityLevel = "RUNTIME";

  async detect(files: string[], rootDir: string): Promise<DetectionResult> {
    const k8sFiles = files.filter(f => 
      f.includes("k8s/") || 
      f.includes("kubernetes/") || 
      f.endsWith("Chart.yaml") ||
      f.endsWith("values.yaml") ||
      f.endsWith("deployment.yaml") ||
      f.endsWith("service.yaml")
    );

    if (k8sFiles.length > 0) {
      return {
        detected: true,
        confidence: 1.0,
        reasons: [`Discovered Kubernetes/Helm files in repository: ${k8sFiles.slice(0, 3).join(", ")}`],
        capabilities: ["kubernetes_orchestration", "readiness_probes", "resource_limits"]
      };
    }

    // Fallback: check if any yaml file contains apiVersion:
    const yamlFiles = files.filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
    for (const yamlFile of yamlFiles) {
      try {
        const content = await fs.promises.readFile(path.join(rootDir, yamlFile), "utf-8");
        if (content.includes("apiVersion:") && content.includes("kind:")) {
          return {
            detected: true,
            confidence: 0.9,
            reasons: [`Discovered Kubernetes resource manifest in ${yamlFile}`],
            capabilities: ["kubernetes_orchestration"]
          };
        }
      } catch {}
    }

    return {
      detected: false,
      confidence: 0,
      reasons: ["No Kubernetes indicators found"],
      capabilities: []
    };
  }

  async contributeArchitecture(rootDir: string): Promise<ArchitectureContribution> {
    return {
      nodes: [
        { id: "deployment:kubernetes", type: "Kubernetes resource", metadata: { name: "Kubernetes Orchestration" } }
      ],
      edges: []
    };
  }
}
