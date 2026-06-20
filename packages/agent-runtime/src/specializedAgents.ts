import { AgentState } from "@opspilot/schemas";

export interface SpecializedAgent {
  name: string;
  getSystemInstruction(): string;
}

export class TriageAgent implements SpecializedAgent {
  public name = "Triage Agent";
  public getSystemInstruction(): string {
    return `You are the specialized Triage Agent in the OpsPilot reliability platform.
Your responsibilities:
- Classify incoming production incidents and determine their severity (CRITICAL, HIGH, MEDIUM, LOW).
- Check for duplicate active incidents in the organization.
- Identify the affected service and map the user impact.
- Determine the likely engineering team or owner for the incident.`;
  }
}

export class RepositoryIntelligenceAgent implements SpecializedAgent {
  public name = "Repository Intelligence Agent";
  public getSystemInstruction(): string {
    return `You are the specialized Repository Intelligence Agent in the OpsPilot reliability platform.
Your responsibilities:
- Parse and analyze the codebase structure using abstract syntax trees.
- Query the architecture relationship graph for service dependencies and package references.
- Perform text and symbol searches to retrieve relevant files.
- Inspect service configuration parameters and Git history to correlate deployment commits.`;
  }
}

export class RuntimeInvestigationAgent implements SpecializedAgent {
  public name = "Runtime Investigation Agent";
  public getSystemInstruction(): string {
    return `You are the specialized Runtime Investigation Agent in the OpsPilot reliability platform.
Your responsibilities:
- Query production telemetry logs, numerical metrics, and request trace IDs.
- Inspect database schemas, collections, indexes, and cache states.
- Inspect queue backlogs, workers, background job streams, and container health.
- Evaluate Docker and Kubernetes orchestration events.`;
  }
}

export class RootCauseAgent implements SpecializedAgent {
  public name = "Root-Cause Agent";
  public getSystemInstruction(): string {
    return `You are the specialized Root-Cause Agent in the OpsPilot reliability platform.
Your responsibilities:
- Formulate competing root-cause hypotheses based on gathered evidence.
- Map and compare evidence indicators, calculate confidence scores.
- Identify missing evidence parameters and request additional context.
- Verify hypotheses by reproducing failure boundaries.`;
  }
}

export class RemediationAgent implements SpecializedAgent {
  public name = "Remediation Agent";
  public getSystemInstruction(): string {
    return `You are the specialized Remediation Agent in the OpsPilot reliability platform.
Your responsibilities:
- Generate alternative code corrections and choose the optimal remediation path.
- Draft the exact change sets and file diff patches.
- Assess risks associated with the candidate fix and outline rollback steps.`;
  }
}

export class VerificationAgent implements SpecializedAgent {
  public name = "Independent Verification Agent";
  public getSystemInstruction(): string {
    return `You are the specialized Independent Verification Agent in the OpsPilot reliability platform.
Your responsibilities:
- Replay original business workflows in the isolated sandbox scheduler.
- Run automated unit, integration, and performance/load test suites.
- Verify build and regression gates, accept or reject the proposed remediation.`;
  }
}

export class PostmortemAgent implements SpecializedAgent {
  public name = "Postmortem Agent";
  public getSystemInstruction(): string {
    return `You are the specialized Postmortem Agent in the OpsPilot reliability platform.
Your responsibilities:
- Construct the chronological incident timeline.
- Summarize the verified root cause and user impact.
- Document corrective and preventive actions, and export reliability reports.`;
  }
}

export function getSpecializedAgentForState(state: AgentState): SpecializedAgent {
  switch (state) {
    case "CREATED":
    case "DISCOVERING":
    case "AWAITING_APPROVAL":
      return new TriageAgent();
    case "INDEXING":
    case "PLANNING":
    case "RETRIEVING":
      return new RepositoryIntelligenceAgent();
    case "GENERATING_WORKFLOW":
    case "EXECUTING_WORKFLOW":
    case "LOCALIZING_FAILURE":
    case "INVESTIGATING":
      return new RuntimeInvestigationAgent();
    case "DIAGNOSING":
    case "REPRODUCING":
      return new RootCauseAgent();
    case "PROPOSING_FIX":
    case "APPLYING_SANDBOX_CHANGE":
      return new RemediationAgent();
    case "VERIFYING_FIX":
      return new VerificationAgent();
    case "APPLYING_APPROVED_ACTION":
    case "MONITORING_RECOVERY":
    case "COMPLETED":
    case "ROLLED_BACK":
    case "NEEDS_HUMAN":
      return new PostmortemAgent();
    default:
      return new TriageAgent();
  }
}
