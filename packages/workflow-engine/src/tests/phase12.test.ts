import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverBrowserContracts } from "../browserDiscovery.js";
import { StatefulWorkflowPlanner } from "../statefulPlanner.js";
import { WorkflowDrivers } from "../drivers.js";
import { EndpointContract, BrowserContract } from "@opspilot/schemas";

export async function runPhase12Tests() {
  console.log("=== Running Phase 12 Browser Automation & Discovery Tests ===");

  // ----------------------------------------------------
  // Test 1: Browser Contract Discovery
  // ----------------------------------------------------
  console.log("Testing Browser Contract Discovery...");

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opspilot-browser-discovery-"));
  
  // Write a mock Next.js App page.tsx
  const appPageDir = path.join(tempDir, "src/app/orders");
  await fs.promises.mkdir(appPageDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(appPageDir, "page.tsx"),
    `
    export default function OrdersPage() {
      return (
        <div>
          <h1>Orders</h1>
          <form data-testid="orders-form">
            <input type="text" name="orderId" placeholder="Order ID" data-testid="order-id-input" />
            <select name="status" data-testid="status-select">
              <option value="pending">Pending</option>
              <option value="completed">Completed</option>
            </select>
            <input type="checkbox" name="agree" data-testid="agree-checkbox" />
            <button type="submit" data-testid="submit-btn">Submit</button>
          </form>
        </div>
      );
    }
    `
  );

  const discoveredContracts = await discoverBrowserContracts(tempDir);
  
  assert.strictEqual(discoveredContracts.length, 1, "Expected 1 browser contract to be discovered");
  const contract = discoveredContracts[0];
  assert.strictEqual(contract.path, "/orders", "Expected route path to be /orders");
  
  // Verify elements
  const inputEl = contract.elements.find(e => e.name === "orderId");
  assert.ok(inputEl, "Expected orderId input element");
  assert.strictEqual(inputEl.type, "input");
  assert.strictEqual(inputEl.selector, '[data-testid="order-id-input"]');

  const selectEl = contract.elements.find(e => e.name === "status");
  assert.ok(selectEl, "Expected status select element");
  assert.strictEqual(selectEl.type, "select");
  assert.strictEqual(selectEl.selector, '[data-testid="status-select"]');

  const checkboxEl = contract.elements.find(e => e.name === "agree");
  assert.ok(checkboxEl, "Expected agree checkbox element");
  assert.strictEqual(checkboxEl.type, "checkbox");
  assert.strictEqual(checkboxEl.selector, '[data-testid="agree-checkbox"]');

  const buttonEl = contract.elements.find(e => e.type === "button");
  assert.ok(buttonEl, "Expected submit button");
  assert.strictEqual(buttonEl.selector, '[data-testid="submit-btn"]');

  await fs.promises.rm(tempDir, { recursive: true, force: true });
  console.log("✓ Browser Contract Discovery verified.");

  // ----------------------------------------------------
  // Test 2: Stateful Planner Browser Integration
  // ----------------------------------------------------
  console.log("Testing Stateful Planner Browser Integration...");

  const mockContracts: EndpointContract[] = [
    {
      id: "create-order",
      method: "POST",
      path: "/api/orders",
      framework: "express" as const,
      source: { file: "orders.ts", line: 10 },
      summary: "Create Order",
      tags: [],
      parameters: [],
      responses: [],
      security: [],
      middleware: [],
      requiredEnvironment: [],
      roles: [],
      permissions: [],
      prisma: [],
      evidence: [],
      confidence: 1.0
    }
  ];

  const mockBrowserContracts: BrowserContract[] = [
    {
      id: "browser-orders",
      path: "/orders",
      elements: [
        { type: "input", selector: 'input[name="orderId"]', name: "orderId" },
        { type: "select", selector: "select[name=\"status\"]", name: "status" },
        { type: "checkbox", selector: "input[type=\"checkbox\"]", name: "agree" },
        { type: "button", selector: "button.submit", label: "Submit" }
      ],
      source: { file: "src/app/orders/page.tsx", line: 1 }
    }
  ];

  const planner = new StatefulWorkflowPlanner("http://fixture.local");
  const plan = await planner.planWorkflow(
    "proj-browser-test",
    mockContracts,
    [],
    [],
    [],
    mockBrowserContracts
  );

  // We expect steps:
  // 1. Create Orders (HTTP)
  // 2. Navigate to /orders (Browser)
  // 3. Fill orderId (Browser)
  // 4. Select status (Browser)
  // 5. Check checkbox (Browser)
  // 6. Click Submit (Browser)
  
  const steps = plan.steps;
  const navigateStep = steps.find(s => s.name === "Navigate to /orders");
  assert.ok(navigateStep, "Expected navigate step to be generated");
  assert.strictEqual(navigateStep.type, "BROWSER_ACTION");
  assert.strictEqual(navigateStep.config.action, "navigate");
  assert.strictEqual(navigateStep.config.url, "/orders");

  const fillStep = steps.find(s => s.name === "Fill orderId on /orders");
  assert.ok(fillStep, "Expected fill step to be generated");
  assert.strictEqual(fillStep.type, "BROWSER_ACTION");
  assert.strictEqual(fillStep.config.action, "fill");
  assert.strictEqual(fillStep.config.selector, 'input[name="orderId"]');
  assert.strictEqual(fillStep.config.text, "test-orderId");

  const selectStep = steps.find(s => s.name === "Select option in status on /orders");
  assert.ok(selectStep, "Expected select step to be generated");
  assert.strictEqual(selectStep.type, "BROWSER_ACTION");
  assert.strictEqual(selectStep.config.action, "select");
  assert.strictEqual(selectStep.config.selector, 'select[name="status"]');
  assert.strictEqual(selectStep.config.value, "1");

  const checkStep = steps.find(s => s.name === "Check checkbox in agree on /orders");
  assert.ok(checkStep, "Expected check checkbox step to be generated");
  assert.strictEqual(checkStep.type, "BROWSER_ACTION");
  assert.strictEqual(checkStep.config.action, "check");
  assert.strictEqual(checkStep.config.selector, 'input[type="checkbox"]');

  const clickStep = steps.find(s => s.name === "Click Submit on /orders");
  assert.ok(clickStep, "Expected click step to be generated");
  assert.strictEqual(clickStep.type, "BROWSER_ACTION");
  assert.strictEqual(clickStep.config.action, "click");
  assert.strictEqual(clickStep.config.selector, "button.submit");

  // Verify sequencing
  const httpCreateId = steps.find(s => s.name === "Create Orders")?.id;
  assert.ok(httpCreateId, "Expected HTTP Create Orders step");
  
  assert.deepStrictEqual(navigateStep.config.dependsOn, [httpCreateId], "Navigate step should depend on HTTP Create Orders step");
  assert.deepStrictEqual(fillStep.config.dependsOn, [navigateStep.id], "Fill step should depend on Navigate step");
  assert.deepStrictEqual(selectStep.config.dependsOn, [fillStep.id], "Select step should depend on Fill step");
  assert.deepStrictEqual(checkStep.config.dependsOn, [selectStep.id], "Check step should depend on Select step");
  assert.deepStrictEqual(clickStep.config.dependsOn, [checkStep.id], "Click step should depend on Check step");

  console.log("✓ Stateful Planner Browser Integration verified.");

  // ----------------------------------------------------
  // Test 3: Playwright Browser Actions End-to-End Execution
  // ----------------------------------------------------
  console.log("Testing Playwright Browser Actions End-to-End...");

  const driverTempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opspilot-browser-driver-"));
  const htmlFile = path.join(driverTempDir, "test.html");
  const uploadFile = path.join(driverTempDir, "dummy.txt");

  await fs.promises.writeFile(uploadFile, "hello from upload file");
  await fs.promises.writeFile(
    htmlFile,
    `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Test Page</title>
      </head>
      <body>
        <input type="text" id="myinput" name="foo" />
        <select id="myselect" name="bar">
          <option value="opt1">Option 1</option>
          <option value="opt2">Option 2</option>
        </select>
        <input type="checkbox" id="mycheckbox" name="agree" />
        <input type="file" id="myfile" />
        <button id="mybutton" onclick="document.body.innerHTML += '<div id=\\'clicked-msg\\'>Clicked</div>'">Submit</button>
      </body>
    </html>
    `
  );

  const drivers = new WorkflowDrivers("file:///");
  const fileUrl = `file:///${htmlFile.replace(/\\/g, "/")}`;

  // 1. Navigate
  let res = await drivers.executeBrowserStep({
    action: "navigate",
    url: fileUrl,
    sessionId: "test-session"
  });
  assert.strictEqual(res.success, true, `Navigate failed: ${res.log}`);

  // 2. Fill
  res = await drivers.executeBrowserStep({
    action: "fill",
    selector: "#myinput",
    text: "hello world",
    sessionId: "test-session"
  });
  assert.strictEqual(res.success, true, `Fill failed: ${res.log}`);

  // 3. Select
  res = await drivers.executeBrowserStep({
    action: "select",
    selector: "#myselect",
    value: "opt2",
    sessionId: "test-session"
  });
  assert.strictEqual(res.success, true, `Select failed: ${res.log}`);

  // 4. Check
  res = await drivers.executeBrowserStep({
    action: "check",
    selector: "#mycheckbox",
    sessionId: "test-session"
  });
  assert.strictEqual(res.success, true, `Check failed: ${res.log}`);

  // 5. Upload File
  res = await drivers.executeBrowserStep({
    action: "upload_file",
    selector: "#myfile",
    filePath: uploadFile,
    sessionId: "test-session"
  });
  assert.strictEqual(res.success, true, `Upload file failed: ${res.log}`);

  // 6. Hover
  res = await drivers.executeBrowserStep({
    action: "hover",
    selector: "#mybutton",
    sessionId: "test-session"
  });
  assert.strictEqual(res.success, true, `Hover failed: ${res.log}`);

  // 7. Focus
  res = await drivers.executeBrowserStep({
    action: "focus",
    selector: "#myinput",
    sessionId: "test-session"
  });
  assert.strictEqual(res.success, true, `Focus failed: ${res.log}`);

  // 8. Wait for Selector / Assert visible
  res = await drivers.executeBrowserStep({
    action: "assert_visible",
    selector: "#mybutton",
    sessionId: "test-session"
  });
  assert.strictEqual(res.success, true, `Assert visible failed: ${res.log}`);

  // 9. Set Viewport
  res = await drivers.executeBrowserStep({
    action: "set_viewport",
    width: 800,
    height: 600,
    sessionId: "test-session"
  });
  assert.strictEqual(res.success, true, `Set Viewport failed: ${res.log}`);

  // 10. Click
  res = await drivers.executeBrowserStep({
    action: "click",
    selector: "#mybutton",
    sessionId: "test-session"
  });
  assert.strictEqual(res.success, true, `Click failed: ${res.log}`);

  // 11. Wait for selector (the new div added on click)
  res = await drivers.executeBrowserStep({
    action: "wait_for_selector",
    selector: "#clicked-msg",
    sessionId: "test-session"
  });
  assert.strictEqual(res.success, true, `Wait for selector failed: ${res.log}`);

  // Clean up Playwright sessions
  await drivers.closeAll();
  await fs.promises.rm(driverTempDir, { recursive: true, force: true });
  console.log("✓ Playwright Browser Actions verified.");

  console.log("✓ All Phase 12 Browser Automation & Discovery Tests Passed!");
}
