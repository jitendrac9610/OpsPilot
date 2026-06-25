import { prisma } from "@opspilot/database";
import { logger } from "@opspilot/shared";
import { AgentState, AgentDecision } from "@opspilot/schemas";
import { ModelGateway } from "@opspilot/model-gateway";
import { PolicyEngine, PolicyContext } from "@opspilot/policy-engine";
import { ToolRegistry } from "@opspilot/tool-registry";
import { MemoryManager } from "@opspilot/memory";
import { RAGPipeline } from "@opspilot/rag";
import { AgentStateMachine } from "./stateMachine.js";
import { BudgetController, BudgetLimits } from "./budget.js";
import { Planner } from "./planner.js";
import { HypothesisEngine } from "./hypothesis.js";
import { EvidenceManager } from "./evidence.js";
import { getSpecializedAgentForState } from "./specializedAgents.js";

export interface OrchestratorConfig {
  agentRunId?: string;
  workflowRunId?: string;
  incidentId?: string;
  snapshotId?: string;
  goal: string;
  budgetLimits?: Partial<BudgetLimits>;
  isProduction?: boolean;
}

export class AgentOrchestrator {
  public agentRunId: string;
  public workflowRunId: string;
  public incidentId: string;
  public snapshotId: string;
  public goal: string;

  public stateMachine: AgentStateMachine;
  public budget: BudgetController;
  public planner: Planner;
  public hypothesisEngine: HypothesisEngine;
  public evidenceManager: EvidenceManager;
  public modelGateway: ModelGateway;
  public policyEngine: PolicyEngine;
  public toolRegistry: ToolRegistry;
  public memory: MemoryManager;
  private rag: RAGPipeline;

  private isProduction: boolean;
  private approvedActionIds: string[] = [];
  private dbFallback = false;
  private extraRetrievalContexts: string[] = [];
  private stateDwellTimes = new Map<AgentState, number>();
  private lastActions: AgentDecision[] = [];

  constructor(config: OrchestratorConfig) {
    this.agentRunId = config.agentRunId || `run-${Math.random().toString(36).substring(2, 9)}`;
    this.workflowRunId = config.workflowRunId || `wf-${Math.random().toString(36).substring(2, 9)}`;
    this.incidentId = config.incidentId || `inc-${Math.random().toString(36).substring(2, 9)}`;
    this.snapshotId = config.snapshotId || "";
    this.goal = config.goal;

    this.stateMachine = new AgentStateMachine("CREATED");
    this.budget = new BudgetController(config.budgetLimits);
    this.planner = new Planner(this.agentRunId, this.goal);
    this.hypothesisEngine = new HypothesisEngine(this.agentRunId);
    this.evidenceManager = new EvidenceManager(this.agentRunId);

    this.modelGateway = new ModelGateway();
    this.policyEngine = new PolicyEngine();
    this.toolRegistry = new ToolRegistry();
    this.memory = new MemoryManager();
    this.rag = new RAGPipeline();

    this.isProduction = config.isProduction || false;
  }

  public addApprovedActionId(actionId: string) {
    this.approvedActionIds.push(actionId);
  }

  /**
   * Initializes the agent run record in the database
   */
  public async initializeRun() {
    try {
      await prisma.agentRun.create({
        data: {
          id: this.agentRunId,
          workflowRunId: this.workflowRunId,
          status: this.stateMachine.getState()
        }
      });
    } catch (err: any) {
      logger.warn({ err }, "Database agentRun creation failed. Bypassing DB updates.");
      this.dbFallback = true;
    }

    const repoPlan = await this.generateRepositorySpecificPlan();
    await this.planner.initializePlan(repoPlan);
  }

  private async generateRepositorySpecificPlan(): Promise<string[]> {
    const basePlan = [
      "Discover running services and configurations",
      "Retrieve log events and identify failures",
      "Formulate root cause hypotheses"
    ];

    if (this.snapshotId && !this.dbFallback) {
      try {
        const archVersion = await prisma.architectureVersion.findFirst({
          where: { snapshotId: this.snapshotId },
          orderBy: { createdAt: "desc" }
        });
        if (archVersion) {
          const nodes = await prisma.graphNode.findMany({
            where: { versionId: archVersion.id }
          });
          const techList: string[] = [];
          const nodeNames = nodes.map(n => n.name.toLowerCase());
          
          if (nodeNames.some(name => name.includes("prisma"))) techList.push("Prisma Database");
          if (nodeNames.some(name => name.includes("queue") || name.includes("bullmq") || name.includes("job"))) techList.push("BullMQ Queue");
          if (nodeNames.some(name => name.includes("socket") || name.includes("websocket"))) techList.push("WebSocket Connection");
          if (nodeNames.some(name => name.includes("webhook") || name.includes("stripe"))) techList.push("Stripe Webhook");

          if (techList.length > 0) {
            basePlan.push(`Verify and reproduce the incident focusing on ${techList.join(", ")} integration`);
          } else {
            basePlan.push("Verify and reproduce the incident");
          }
        } else {
          basePlan.push("Verify and reproduce the incident");
        }
      } catch (err) {
        logger.warn({ err }, "Failed to generate repository-specific plan details. Falling back.");
        basePlan.push("Verify and reproduce the incident");
      }
    } else {
      basePlan.push("Verify and reproduce the incident");
    }

    basePlan.push(
      "Propose correction and request verification approval",
      "Monitor recovery and complete resolution"
    );

    return basePlan;
  }

  /**
   * Single step of the execution loop
   */
  public async step(): Promise<{ state: AgentState; decision: AgentDecision }> {
    const currentState = this.stateMachine.getState();
    this.budget.recordStateTransition(currentState);

    logger.info({ state: currentState, runId: this.agentRunId }, "Running agent step");

    // 1. Gather context via RAG
    this.budget.recordRetrieval();
    let contextText = `Incident Resolution Goal: ${this.goal}\n`;
    if (!this.snapshotId) {
      contextText += "\n(NO_REPOSITORY_SNAPSHOT: Code-grounded retrieval is unavailable.)";
    } else {
      try {
        const ragCtx = await this.rag.retrieveHybridContext(this.goal, {
          snapshotId: this.snapshotId,
          agentRunId: this.agentRunId,
          workflowRunId: this.workflowRunId,
          incidentId: this.incidentId,
          skipRewrite: true
        });
        contextText += ragCtx.fullContextText;
      } catch (err: any) {
        logger.warn({ err }, "RAG retrieval failed.");
        contextText += `\n(RAG_RETRIEVAL_FAILED: No repository context was added.)`;
      }
    }

    if (this.extraRetrievalContexts.length > 0) {
      contextText += `\n\n## Targeted Retrieval Context:\n` + this.extraRetrievalContexts.join("\n\n");
    }

    // Append memory, planner, hypothesis and evidence information to prompt
    contextText += `\n\n## Current Plan Steps:\n` + JSON.stringify(this.planner.getSteps(), null, 2);
    contextText += `\n\n## Hypotheses:\n` + JSON.stringify(this.hypothesisEngine.getHypotheses(), null, 2);
    contextText += `\n\n## Gathered Evidence:\n` + JSON.stringify(this.evidenceManager.getEvidence(), null, 2);
    contextText += `\n\n## Missing Evidence:\n` + JSON.stringify(this.evidenceManager.getMissingEvidence(), null, 2);

    const prompt = `You are OpsPilot's incident resolution engine. Analyze the context and choose the next action.\n\nContext:\n${contextText}`;

    // 2. Generate structured decision from LLM (Model Gateway)
    this.budget.recordModelCall();
    const specializedAgent = getSpecializedAgentForState(currentState);
    const modelResult = await this.modelGateway.generateDecision(prompt, currentState, {
      systemInstruction: specializedAgent.getSystemInstruction()
    });
    const decision = modelResult.decision;

    // Persist step log to DB
    if (!this.dbFallback) {
      try {
        await prisma.agentStep.create({
          data: {
            agentRunId: this.agentRunId,
            state: currentState,
            decision: decision as any
          }
        });
      } catch (err: any) {
        logger.warn({ err }, "Failed to write agent step log to database");
      }
    }

    // 3. Process Decision
    await this.processDecision(decision);

    // 4. Save Checkpoint
    await this.saveCheckpoint();

    // 5. Evaluate state transition based on decision
    this.transitionStateBasedOnDecision(decision);

    return {
      state: this.stateMachine.getState(),
      decision
    };
  }

  /**
   * Executes E2E loop until COMPLETED, ROLLED_BACK, or NEEDS_HUMAN.
   */
  public async run(): Promise<AgentState> {
    await this.initializeRun();

    while (
      this.stateMachine.getState() !== "COMPLETED" &&
      this.stateMachine.getState() !== "ROLLED_BACK" &&
      this.stateMachine.getState() !== "NEEDS_HUMAN"
    ) {
      try {
        await this.step();
      } catch (err: any) {
        logger.error({ err }, "Execution loop encountered an error. Transitioning to NEEDS_HUMAN.");
        this.stateMachine.transitionTo("NEEDS_HUMAN");
        break;
      }
    }

    logger.info({ status: this.stateMachine.getState() }, "Agent Run finished.");
    return this.stateMachine.getState();
  }

  private async processDecision(decision: AgentDecision) {
    switch (decision.type) {
      case "retrieve": {
        logger.info({ query: decision.request }, "Decision: retrieve extra context");
        const query = typeof decision.request.query === "string"
          ? decision.request.query
          : JSON.stringify(decision.request);

        if (this.snapshotId) {
          try {
            const extraCtx = await this.rag.retrieveHybridContext(query, {
              snapshotId: this.snapshotId,
              agentRunId: this.agentRunId,
              workflowRunId: this.workflowRunId,
              incidentId: this.incidentId,
              skipRewrite: true
            });
            this.extraRetrievalContexts.push(extraCtx.fullContextText);
          } catch (err: any) {
            logger.warn({ err }, "Dynamic targeted RAG retrieval failed.");
          }
        }
        break;
      }

      case "call_tool": {
        const { tool, arguments: args } = decision;
        logger.info({ tool, args }, "Decision: call tool");

        // Check tool safety policy
        const policyCtx: PolicyContext = {
          isProduction: this.isProduction,
          approvedActionIds: this.approvedActionIds
        };
        const policy = this.policyEngine.evaluate(tool, args, policyCtx);
        if (!policy.allowed) {
          logger.warn({ tool, reason: policy.reason }, "Policy engine blocked tool call.");
          if (policy.requiresApproval) {
            // Need human approval card
            this.stateMachine.transitionTo("AWAITING_APPROVAL");
          } else {
            this.stateMachine.transitionTo("NEEDS_HUMAN");
          }
          throw new Error(`Policy engine blocked tool execution: ${policy.reason}`);
        }

        // Execute tool
        this.budget.recordToolCall();
        const toolResult = await this.toolRegistry.execute(tool, args);

        // Record tool call & attempt
        if (!this.dbFallback) {
          try {
            const step = await prisma.agentStep.findFirst({
              where: { agentRunId: this.agentRunId },
              orderBy: { timestamp: "desc" }
            });
            if (step) {
              const tc = await prisma.toolCall.create({
                data: {
                  stepId: step.id,
                  toolName: tool,
                  arguments: args as any
                }
              });
              await prisma.toolExecutionAttempt.create({
                data: {
                  toolCallId: tc.id,
                  success: toolResult.success,
                  output: toolResult.output as any
                }
              });
            }
          } catch (err: any) {
            logger.warn({ err }, "Database tool call tracking failed");
          }
        }

        // Add tool result as evidence
        await this.evidenceManager.addEvidence(
          "TOOL_EXECUTION",
          { tool, arguments: args, success: toolResult.success, output: toolResult.output }
        );
        if (!toolResult.success) {
          throw new Error(`TOOL_EXECUTION_FAILED: ${tool}`);
        }
        break;
      }

      case "update_hypotheses": {
        logger.info({ updates: decision.updates }, "Decision: update hypotheses");
        for (const update of decision.updates) {
          const description = update.description || "Root cause hypothesis";
          const confidence = typeof update.confidence === "number" ? update.confidence : 50;
          const status = update.status || "NEUTRAL";
          if (status === "SUPPORTED" && this.evidenceManager.getEvidence().length === 0) {
            throw new Error("EVIDENCE_REQUIRED: A hypothesis cannot be SUPPORTED without attached run evidence.");
          }

          // Find existing hypothesis
          const existing = this.hypothesisEngine.getHypotheses().find((h) => h.description === description);
          if (existing && existing.id) {
            await this.hypothesisEngine.updateHypothesis(existing.id, { confidence, status });
          } else {
            await this.hypothesisEngine.addHypothesis(description, confidence);
          }
        }
        break;
      }

      case "replan":
        logger.info({ reason: decision.reason }, "Decision: replan");
        await this.planner.replan(decision.reason, [
          `Address replan reason: ${decision.reason}`,
          "Execute dynamic correction plan based on failure updates",
          "Complete resolution"
        ]);
        break;

      case "propose_change":
        logger.info({ plan: decision.plan }, "Decision: propose correction changes");
        // Record proposal memory
        await this.memory.createRecord(this.agentRunId, "working", {
          proposal: decision.plan
        });
        break;

      case "request_approval":
        logger.info({ approval: decision.approval }, "Decision: request human approval");
        if (!this.dbFallback) {
          try {
            const diagnosis = await prisma.diagnosis.create({
              data: {
                agentRunId: this.agentRunId,
                content: decision.approval as any,
                confidence: 90
              }
            });
            const plan = await prisma.remediationPlan.create({
              data: {
                diagnosisId: diagnosis.id,
                title: "Agent proposed remediation plan",
                description: JSON.stringify(decision.approval),
                steps: decision.approval as any,
                status: "PENDING"
              }
            });
            await prisma.approvalRequest.create({
              data: {
                remediationPlanId: plan.id,
                status: "PENDING",
                requestedBy: "agent-runtime"
              }
            });
          } catch (err: any) {
            logger.warn({ err }, "Failed to save approval request to database");
          }
        }
        break;

      case "complete":
        logger.info({ conclusion: decision.conclusion }, "Decision: complete resolution");
        await this.memory.createRecord(this.agentRunId, "incident", {
          conclusion: decision.conclusion
        });
        break;

      case "needs_human":
        logger.info({ missingEvidence: decision.missingEvidence }, "Decision: needs human feedback");
        this.evidenceManager.setMissingEvidence(decision.missingEvidence);
        break;
    }
  }

  private transitionStateBasedOnDecision(decision: AgentDecision) {
    const currentState = this.stateMachine.getState();

    // Track dwell time and repeated actions
    const dwell = (this.stateDwellTimes.get(currentState) || 0) + 1;
    this.stateDwellTimes.set(currentState, dwell);

    if (dwell > 5) {
      this.transitionToNeedsHuman(`State dwell time limit exceeded in state: ${currentState}`);
      return;
    }

    this.lastActions.push(decision);
    if (this.lastActions.length > 5) this.lastActions.shift();
    if (this.lastActions.length >= 3) {
      const last3 = this.lastActions.slice(-3);
      if (last3.every(act => JSON.stringify(act) === JSON.stringify(last3[0]))) {
        this.transitionToNeedsHuman(`Repeated action loop detected.`);
        return;
      }
    }

    let matched = false;

    // 1. Perform primary transitions
    switch (currentState) {
      case "CREATED":
        if (decision.type === "call_tool" && decision.tool === "list_services") {
          this.stateMachine.transitionTo("DISCOVERING");
          this.stateDwellTimes.set("DISCOVERING", 0);
          matched = true;
        }
        break;
      case "DISCOVERING":
        if (decision.type === "call_tool" && decision.tool === "index_repository") {
          this.stateMachine.transitionTo("INDEXING");
          this.stateDwellTimes.set("INDEXING", 0);
          matched = true;
        }
        break;
      case "INDEXING":
        if (decision.type === "replan" || decision.type === "retrieve") {
          this.stateMachine.transitionTo("PLANNING");
          this.stateDwellTimes.set("PLANNING", 0);
          matched = true;
        }
        break;
      case "PLANNING":
        if (decision.type === "retrieve" || decision.type === "replan") {
          this.stateMachine.transitionTo("RETRIEVING");
          this.stateDwellTimes.set("RETRIEVING", 0);
          matched = true;
        }
        break;
      case "RETRIEVING":
        if (decision.type === "call_tool" || decision.type === "retrieve") {
          this.stateMachine.transitionTo("INVESTIGATING");
          this.stateDwellTimes.set("INVESTIGATING", 0);
          matched = true;
        }
        break;
      case "INVESTIGATING":
        if (decision.type === "update_hypotheses" && this.evidenceManager.getEvidence().length > 0) {
          this.stateMachine.transitionTo("DIAGNOSING");
          this.stateDwellTimes.set("DIAGNOSING", 0);
          matched = true;
        }
        break;
      case "DIAGNOSING":
        if (decision.type === "call_tool" && decision.tool === "run_tests") {
          this.stateMachine.transitionTo("REPRODUCING");
          this.stateDwellTimes.set("REPRODUCING", 0);
          matched = true;
        }
        break;
      case "REPRODUCING":
        if (decision.type === "propose_change") {
          this.stateMachine.transitionTo("PROPOSING_FIX");
          this.stateDwellTimes.set("PROPOSING_FIX", 0);
          matched = true;
        }
        break;
      case "PROPOSING_FIX":
        if (decision.type === "call_tool" && decision.tool === "apply_patch") {
          this.stateMachine.transitionTo("APPLYING_SANDBOX_CHANGE");
          this.stateDwellTimes.set("APPLYING_SANDBOX_CHANGE", 0);
          matched = true;
        }
        break;
      case "APPLYING_SANDBOX_CHANGE": {
        const verified = decision.type === "request_approval" && this.approvalHasVerificationEvidence(decision.approval);
        if (verified) {
          this.stateMachine.transitionTo("VERIFYING_FIX");
          this.stateMachine.transitionTo("AWAITING_APPROVAL");
          this.stateDwellTimes.set("AWAITING_APPROVAL", 0);
          matched = true;
        }
        break;
      }
      case "VERIFYING_FIX":
        if (decision.type === "request_approval" && this.approvalHasVerificationEvidence(decision.approval)) {
          this.stateMachine.transitionTo("AWAITING_APPROVAL");
          this.stateDwellTimes.set("AWAITING_APPROVAL", 0);
          matched = true;
        }
        break;
      case "AWAITING_APPROVAL":
        if (decision.type === "call_tool" && decision.tool === "approve_action") {
          this.stateMachine.transitionTo("APPLYING_APPROVED_ACTION");
          this.stateDwellTimes.set("APPLYING_APPROVED_ACTION", 0);
          matched = true;
        }
        break;
      case "APPLYING_APPROVED_ACTION":
        this.stateMachine.transitionTo("MONITORING_RECOVERY");
        this.stateDwellTimes.set("MONITORING_RECOVERY", 0);
        matched = true;
        break;
      case "MONITORING_RECOVERY":
        if (decision.type === "complete") {
          this.stateMachine.transitionTo("COMPLETED");
          matched = true;
        }
        break;
      case "NEEDS_HUMAN":
        this.stateMachine.transitionTo("PLANNING");
        this.stateDwellTimes.set("PLANNING", 0);
        matched = true;
        break;
    }

    if (!matched) {
      if (["retrieve", "replan", "update_hypotheses"].includes(decision.type)) {
        return;
      }
      let reason = `Unexpected action '${decision.type}' in state '${currentState}'`;
      if (decision.type === "call_tool") {
        reason = `Unexpected tool call '${decision.tool}' in state '${currentState}'`;
      }
      this.transitionToNeedsHuman(reason);
    }

    if (decision.type === "needs_human") {
      this.stateMachine.transitionTo("NEEDS_HUMAN");
    }

    if (!this.dbFallback) {
      prisma.agentRun.update({
        where: { id: this.agentRunId },
        data: {
          status: this.stateMachine.getState(),
          completedAt: ["COMPLETED", "ROLLED_BACK", "NEEDS_HUMAN"].includes(this.stateMachine.getState()) ? new Date() : null
        }
      }).catch((err: any) => {
        logger.warn({ err }, "Failed to update agent run status in database");
      });
    }
  }

  private transitionWhen(condition: boolean, nextState: AgentState, failureReason: string) {
    if (condition) {
      this.stateMachine.transitionTo(nextState);
    } else {
      this.transitionToNeedsHuman(failureReason);
    }
  }

  private transitionToNeedsHuman(reason: string) {
    logger.warn({ state: this.stateMachine.getState(), reason }, "Evidence gate blocked agent state transition");
    this.evidenceManager.setMissingEvidence([reason]);
    this.stateMachine.transitionTo("NEEDS_HUMAN");
  }

  private approvalHasVerificationEvidence(approval: any): boolean {
    const verification = approval?.verification;
    return verification?.originalFailureReproduced === true &&
      verification?.buildPassed === true &&
      verification?.workflowPassed === true &&
      Number(verification?.regressionTestsPassedCount) > 0 &&
      verification?.securityRegressionDetected === false;
  }

  private async saveCheckpoint() {
    const checkpointState = {
      state: this.stateMachine.getState(),
      budget: this.budget.getUsage(),
      plan: this.planner.getSteps(),
      planVersion: this.planner.getVersion(),
      hypotheses: this.hypothesisEngine.getHypotheses(),
      evidence: this.evidenceManager.getEvidence(),
      missingEvidence: this.evidenceManager.getMissingEvidence(),
      approvedActionIds: this.approvedActionIds
    };

    logger.debug({ state: checkpointState.state }, "Saving agent checkpoint");

    if (!this.dbFallback) {
      try {
        await prisma.agentCheckpoint.create({
          data: {
            agentRunId: this.agentRunId,
            state: checkpointState as any
          }
        });
      } catch (err: any) {
        logger.warn({ err }, "Failed to save agent checkpoint to database");
      }
    }
  }
}
