import { AdapterCategory, CapabilityLevel, DetectionResult, ArchitectureContribution } from "@opspilot/schemas";

export abstract class OpsPilotAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly category: AdapterCategory;
  abstract readonly capabilityLevel: CapabilityLevel;

  abstract detect(files: string[], rootDir: string): Promise<DetectionResult>;
  abstract contributeArchitecture(rootDir: string): Promise<ArchitectureContribution>;
}
