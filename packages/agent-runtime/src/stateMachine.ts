import { AgentState } from "@opspilot/schemas";
import { logger } from "@opspilot/shared";

export const ALLOWED_TRANSITIONS: Record<AgentState, AgentState[]> = {
  CREATED: ["DISCOVERING", "NEEDS_HUMAN"],
  DISCOVERING: ["INDEXING", "PLANNING", "NEEDS_HUMAN"],
  INDEXING: ["PLANNING", "NEEDS_HUMAN"],
  PLANNING: ["RETRIEVING", "INVESTIGATING", "NEEDS_HUMAN"],
  RETRIEVING: ["GENERATING_WORKFLOW", "INVESTIGATING", "PLANNING", "NEEDS_HUMAN"],
  GENERATING_WORKFLOW: ["EXECUTING_WORKFLOW", "NEEDS_HUMAN"],
  EXECUTING_WORKFLOW: ["LOCALIZING_FAILURE", "INVESTIGATING", "NEEDS_HUMAN"],
  LOCALIZING_FAILURE: ["INVESTIGATING", "NEEDS_HUMAN"],
  INVESTIGATING: ["DIAGNOSING", "NEEDS_HUMAN"],
  DIAGNOSING: ["REPRODUCING", "NEEDS_HUMAN"],
  REPRODUCING: ["PROPOSING_FIX", "NEEDS_HUMAN"],
  PROPOSING_FIX: ["APPLYING_SANDBOX_CHANGE", "NEEDS_HUMAN"],
  APPLYING_SANDBOX_CHANGE: ["VERIFYING_FIX", "NEEDS_HUMAN"],
  VERIFYING_FIX: ["AWAITING_APPROVAL", "NEEDS_HUMAN", "ROLLED_BACK"],
  AWAITING_APPROVAL: ["APPLYING_APPROVED_ACTION", "NEEDS_HUMAN", "ROLLED_BACK"],
  APPLYING_APPROVED_ACTION: ["MONITORING_RECOVERY", "NEEDS_HUMAN", "ROLLED_BACK"],
  MONITORING_RECOVERY: ["COMPLETED", "ROLLED_BACK", "NEEDS_HUMAN"],
  COMPLETED: [],
  ROLLED_BACK: [],
  NEEDS_HUMAN: ["PLANNING", "INVESTIGATING", "APPLYING_APPROVED_ACTION"]
};

export class AgentStateMachine {
  private currentState: AgentState;

  constructor(initialState: AgentState = "CREATED") {
    this.currentState = initialState;
  }

  public getState(): AgentState {
    return this.currentState;
  }

  public transitionTo(nextState: AgentState): void {
    if (this.currentState === nextState) return;

    const allowed = ALLOWED_TRANSITIONS[this.currentState];
    const isAllowed = allowed?.includes(nextState) || nextState === "NEEDS_HUMAN" || nextState === "ROLLED_BACK";
    if (!isAllowed) {
      const msg = `Invalid state transition from ${this.currentState} to ${nextState}`;
      logger.warn(msg);
      throw new Error(msg);
    }

    logger.info(`State transition: ${this.currentState} -> ${nextState}`);
    this.currentState = nextState;
  }
}
