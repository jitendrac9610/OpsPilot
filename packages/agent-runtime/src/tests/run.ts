import assert from "node:assert";
import { AgentStateMachine } from "../stateMachine.js";
import { BudgetController } from "../budget.js";
import { Planner } from "../planner.js";
import { HypothesisEngine } from "../hypothesis.js";
import { EvidenceManager } from "../evidence.js";
import { PolicyEngine } from "@opspilot/policy-engine";
import { ToolRegistry } from "@opspilot/tool-registry";
import { ModelGateway } from "@opspilot/model-gateway";
import { AgentOrchestrator } from "../orchestrator.js";
import { AgentDecision } from "@opspilot/schemas";

async function runTests() {
  console.log("=== Running Agent Runtime Unit Tests ===");

  console.log("\n1. Testing Agent State Machine...");
  {
    const sm = new AgentStateMachine("CREATED");
    assert.strictEqual(sm.getState(), "CREATED");

    sm.transitionTo("DISCOVERING");
    assert.strictEqual(sm.getState(), "DISCOVERING");

    sm.transitionTo("INDEXING");
    assert.strictEqual(sm.getState(), "INDEXING");

    assert.throws(() => {
      sm.transitionTo("COMPLETED");
    }, /Invalid state transition/);

    sm.transitionTo("NEEDS_HUMAN");
    assert.strictEqual(sm.getState(), "NEEDS_HUMAN");

    console.log("✓ State Machine tests passed.");
  }

  console.log("\n2. Testing Planner...");
  {
    const planner = new Planner("test-run-id", "Resolve auth latency");
    await planner.initializePlan(["Step 1", "Step 2"]);
    assert.strictEqual(planner.getVersion(), 1);
    assert.strictEqual(planner.getSteps().length, 2);
    assert.strictEqual(planner.getSteps()[0].status, "PENDING");

    await planner.updateStepStatus(1, "COMPLETED");
    assert.strictEqual(planner.getSteps()[0].status, "COMPLETED");

    await planner.replan("New issue detected", ["New Step 1", "New Step 2"]);
    assert.strictEqual(planner.getVersion(), 2);
    assert.strictEqual(planner.getSteps().length, 2);
    assert.strictEqual(planner.getSteps()[0].status, "PENDING");
    console.log("✓ Planner tests passed.");
  }

  console.log("\n3. Testing Hypothesis & Evidence Managers...");
  {
    const he = new HypothesisEngine("test-run-id");
    const hyp = await he.addHypothesis("Database connection pool saturated", 50);
    assert.strictEqual(he.getHypotheses().length, 1);
    assert.strictEqual(hyp.status, "NEUTRAL");

    if (hyp.id) {
      await he.updateHypothesis(hyp.id, { confidence: 90, status: "SUPPORTED" });
      assert.strictEqual(he.getHypotheses()[0].confidence, 90);
      assert.strictEqual(he.getHypotheses()[0].status, "SUPPORTED");
    }

    const em = new EvidenceManager("test-run-id");
    await em.addEvidence("LOG_ERROR", { msg: "Connection timeout" }, hyp.id);
    assert.strictEqual(em.getEvidence().length, 1);
    assert.strictEqual(em.getEvidence()[0].type, "LOG_ERROR");

    em.setMissingEvidence(["Database CPU metrics"]);
    assert.deepStrictEqual(em.getMissingEvidence(), ["Database CPU metrics"]);
    console.log("✓ Hypothesis & Evidence tests passed.");
  }

  console.log("\n4. Testing Policy Engine...");
  {
    const pe = new PolicyEngine();
    
    const decision1 = pe.evaluate("view_logs", {}, { isProduction: false });
    assert.strictEqual(decision1.allowed, true);
    assert.strictEqual(decision1.requiresApproval, false);

    const decision2 = pe.evaluate("restart_service", { service: "api" }, { isProduction: true });
    assert.strictEqual(decision2.allowed, false);
    assert.strictEqual(decision2.requiresApproval, true);

    const decision3 = pe.evaluate("restart_service", { service: "api", id: "restart_service" }, { isProduction: true, approvedActionIds: ["restart_service"] });
    assert.strictEqual(decision3.allowed, true);
    assert.strictEqual(decision3.requiresApproval, false);

    console.log("✓ Policy Engine tests passed.");
  }

  console.log("\n5. Testing Tool Registry...");
  {
    const tr = new ToolRegistry();
    const list = tr.listTools();
    assert(list.length > 0);
    assert(tr.getTool("view_logs") !== undefined);

    const res = await tr.execute("view_logs", { service: "api-service" });
    assert.strictEqual(res.success, true);
    assert(res.output.includes("Failed to connect to database"));
    console.log("✓ Tool Registry tests passed.");
  }

  console.log("\n6. Testing Budget Controller...");
  {
    const budget = new BudgetController({ maxToolAttempts: 2 });
    budget.recordToolCall();
    budget.recordToolCall();

    assert.throws(() => {
      budget.recordToolCall();
    }, /Budget exceeded/);

    const loopBudget = new BudgetController();
    loopBudget.recordStateTransition("PLANNING");
    loopBudget.recordStateTransition("RETRIEVING");
    loopBudget.recordStateTransition("INVESTIGATING");
    loopBudget.recordStateTransition("DIAGNOSING");
    
    loopBudget.recordStateTransition("PLANNING");
    loopBudget.recordStateTransition("RETRIEVING");
    loopBudget.recordStateTransition("INVESTIGATING");
    
    assert.throws(() => {
      loopBudget.recordStateTransition("DIAGNOSING");
    }, /Loop detected/);

    console.log("✓ Budget Controller tests passed.");
  }

  console.log("\n7. Testing E2E Orchestrator Loop...");
  {
    const orchestrator = new AgentOrchestrator({
      goal: "Investigate and fix failing auth-service",
      isProduction: false,
      budgetLimits: {
        maxRetrievalRounds: 50,
        maxModelAttempts: 50,
        maxStateTransitions: 50
      }
    });

    const mockDecisions: AgentDecision[] = [
      { type: "call_tool", tool: "list_services", arguments: {} }, 
      { type: "call_tool", tool: "index_repository", arguments: {} }, 
      { type: "replan", reason: "Found index results" }, 
      { type: "retrieve", request: { query: "logs" } }, 
      { type: "call_tool", tool: "view_logs", arguments: { service: "auth-service" } }, 
      { type: "update_hypotheses", updates: [{ description: "database host env var missing", confidence: 90, status: "SUPPORTED" }] }, 
      { type: "call_tool", tool: "run_tests", arguments: {} }, 
      { type: "propose_change", plan: { file: "config.json" } }, 
      { type: "call_tool", tool: "apply_patch", arguments: { file: "config.json", patch: "foo" } }, 
      { type: "request_approval", approval: { id: "appr-1" } }, 
      { type: "call_tool", tool: "approve_action", arguments: { id: "appr-1" } }, 
      { type: "call_tool", tool: "apply_approved_changes", arguments: {} }, 
      { type: "complete", conclusion: { summary: "Database connection variable fixed." } } 
    ];

    orchestrator.modelGateway.setMockDecisions(mockDecisions);
    orchestrator.addApprovedActionId("appr-1");

    const finalState = await orchestrator.run();
    assert.strictEqual(finalState, "COMPLETED");
    console.log("✓ E2E Orchestrator Loop tests passed.");
  }

  console.log("\nALL TESTS PASSED SUCCESSFULLY!");
}

runTests().catch((err) => {
  console.error("\nTEST RUN FAILED:", err);
  process.exit(1);
});
