import assert from "node:assert";
import { LoadTestRunner } from "../load.js";
import { ConcurrencyEvaluator } from "../concurrency.js";
import { FailureInjector } from "../injection.js";
import { PerformanceReporter } from "../reports.js";

async function runTests() {
  console.log("=== Running Resilience Testing Unit Tests ===");

  const ltr = new LoadTestRunner(true);
  const ce = new ConcurrencyEvaluator();
  const fi = new FailureInjector(true);
  const pr = new PerformanceReporter();

  const sandboxId = "sb-resilience-123";

  console.log("\n1. Testing Load Test Runner...");
  const baseline = await ltr.runLoadTest(sandboxId, "http://localhost:4000/api/interviews", 1, 10);
  assert.strictEqual(baseline.throughput, 10);
  assert(baseline.latencyP95 > 0);
  assert.strictEqual(baseline.errorRate, 0);
  console.log("✓ Load testing run successfully.");

  console.log("\n2. Testing Concurrency Evaluator...");
  const concRes = await ce.testDuplicateRequests("http://localhost:4000/api/interviews", { candidate: "Bob" }, 5);
  assert.strictEqual(concRes.errorRate, 0);
  assert.strictEqual(concRes.raceConditionsDetected, false);
  assert.strictEqual(concRes.logs.length, 5);
  console.log("✓ Concurrency evaluations passed.");

  console.log("\n3. Testing Failure Injector...");
  const injRes = await fi.injectFailure(sandboxId, "delay_database", { delayMs: 5000 });
  assert.strictEqual(injRes.success, true);
  assert(injRes.injectionId.startsWith("inj-"));
  console.log("✓ Failure injected successfully.");

  console.log("\n4. Testing Performance Reporter...");
  const stressedMetrics = {
    throughput: 8,
    latencyP50: 120,
    latencyP95: 250,
    latencyP99: 300,
    errorRate: 0.08
  };

  const reportText = pr.generateReport(sandboxId, {
    baseline,
    underStress: stressedMetrics
  });
  
  assert(reportText.includes("Throughput Drop"));
  assert(reportText.includes("Latency Increase"));
  assert(reportText.includes("CRITICAL")); 
  console.log("Report Sample Output:\n", reportText);
  console.log("✓ Performance report compiled.");

  console.log("\nALL RESILIENCE TESTING TESTS PASSED SUCCESSFULLY!");
}

runTests().catch((err) => {
  console.error("\nTEST RUN FAILED:", err);
  process.exit(1);
});
