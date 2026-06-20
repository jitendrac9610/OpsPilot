import { OpsPilotAdapter } from "../types.js";
import { AdapterCategory, CapabilityLevel, DetectionResult, ArchitectureContribution } from "@opspilot/schemas";

export class DockerAdapter extends OpsPilotAdapter {
  readonly id = "docker";
  readonly name = "Docker Deployment Adapter";
  readonly category: AdapterCategory = "deployment";
  readonly capabilityLevel: CapabilityLevel = "RUNTIME";

  async detect(files: string[], rootDir: string): Promise<DetectionResult> {
    const hasDockerFiles = files.some(f => 
      f.endsWith("Dockerfile") || 
      f.includes("docker-compose.yml") || 
      f.includes("docker-compose.yaml") ||
      f.endsWith(".dockerignore")
    );

    if (hasDockerFiles) {
      const composeFile = files.find(f => f.includes("docker-compose"));
      const reasons = ["Discovered Docker configuration files in repository"];
      if (composeFile) {
        reasons.push(`Found compose configuration: ${composeFile}`);
      }
      return {
        detected: true,
        confidence: 1.0,
        reasons,
        capabilities: ["containerization", "multi_service_orchestration", "port_mapping"]
      };
    }

    return {
      detected: false,
      confidence: 0,
      reasons: ["No Docker files found"],
      capabilities: []
    };
  }

  async contributeArchitecture(rootDir: string): Promise<ArchitectureContribution> {
    return {
      nodes: [
        { id: "deployment:docker", type: "Docker container", metadata: { name: "Docker Containerization" } }
      ],
      edges: []
    };
  }
}
