import { logger } from "@opspilot/shared";

export interface BudgetLimits {
  maxModelAttempts: number;
  maxRetrievalRounds: number;
  maxToolAttempts: number;
  maxTokenLimit: number;
  maxStateTransitions: number;
}

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxModelAttempts: 30,
  maxRetrievalRounds: 10,
  maxToolAttempts: 50,
  maxTokenLimit: 1000000,
  maxStateTransitions: 100
};

export class BudgetController {
  private limits: BudgetLimits;
  private modelAttempts = 0;
  private retrievalRounds = 0;
  private toolAttempts = 0;
  private tokensUsed = 0;
  private stateTransitions = 0;

  private visitedStates: string[] = [];

  constructor(limits: Partial<BudgetLimits> = {}) {
    this.limits = { ...DEFAULT_BUDGET_LIMITS, ...limits };
  }

  public recordModelCall(tokens = 0) {
    this.modelAttempts++;
    this.tokensUsed += tokens;
    this.checkLimits();
  }

  public recordRetrieval() {
    this.retrievalRounds++;
    this.checkLimits();
  }

  public recordToolCall() {
    this.toolAttempts++;
    this.checkLimits();
  }

  public recordStateTransition(state: string) {
    this.stateTransitions++;
    this.visitedStates.push(state);
    this.checkLimits();
    this.detectLoops();
  }

  public getUsage() {
    return {
      modelAttempts: this.modelAttempts,
      retrievalRounds: this.retrievalRounds,
      toolAttempts: this.toolAttempts,
      tokensUsed: this.tokensUsed,
      stateTransitions: this.stateTransitions
    };
  }

  private checkLimits() {
    if (this.modelAttempts > this.limits.maxModelAttempts) {
      throw new Error(`Budget exceeded: maxModelAttempts (${this.limits.maxModelAttempts}) exceeded.`);
    }
    if (this.retrievalRounds > this.limits.maxRetrievalRounds) {
      throw new Error(`Budget exceeded: maxRetrievalRounds (${this.limits.maxRetrievalRounds}) exceeded.`);
    }
    if (this.toolAttempts > this.limits.maxToolAttempts) {
      throw new Error(`Budget exceeded: maxToolAttempts (${this.limits.maxToolAttempts}) exceeded.`);
    }
    if (this.tokensUsed > this.limits.maxTokenLimit) {
      throw new Error(`Budget exceeded: maxTokenLimit (${this.limits.maxTokenLimit}) exceeded.`);
    }
    if (this.stateTransitions > this.limits.maxStateTransitions) {
      throw new Error(`Budget exceeded: maxStateTransitions (${this.limits.maxStateTransitions}) exceeded.`);
    }
  }

  private detectLoops() {
    const len = this.visitedStates.length;
    if (len >= 8) {
      const last4 = this.visitedStates.slice(len - 4);
      const prev4 = this.visitedStates.slice(len - 8, len - 4);
      if (JSON.stringify(last4) === JSON.stringify(prev4)) {
        throw new Error("Loop detected in agent state transitions!");
      }
    }
  }
}
