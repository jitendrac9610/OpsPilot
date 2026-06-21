import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EndpointContractSchema } from "@opspilot/schemas";
import { WorkflowDiscoverer } from "../discovery.js";
import { WorkflowDrivers } from "../drivers.js";
import { AssertionEngine } from "../assertions.js";
import { CorrelationManager } from "../correlation.js";
import { FailureLocalizer } from "../localization.js";
import { RequestGenerator } from "../requestGenerator.js";
import { AuthBootstrapper } from "../authBootstrapper.js";
import { StatefulWorkflowPlanner } from "../statefulPlanner.js";

async function runTests() {
  const repositoryRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opspilot-workflow-test-"));
  await createContractFixture(repositoryRoot);

  const discoverer = new WorkflowDiscoverer(true);
  const discovered = await discoverer.discover("proj-123", repositoryRoot);
  const contracts = discovered.map((workflow) => workflow.contract);
  assert.ok(contracts.length >= 8, `Expected at least 8 endpoint contracts, received ${contracts.length}`);
  for (const contract of contracts) EndpointContractSchema.parse(contract);

  const expressOrder = contract(contracts, "POST", "/api/orders/:accountId");
  assert.strictEqual(expressOrder.framework, "express");
  assert.ok(expressOrder.security.some((item) => item.type === "bearer"));
  assert.deepStrictEqual(expressOrder.roles, ["admin"]);
  assert.ok(expressOrder.middleware.some((item) => item.name === "validateBody"));
  assert.ok(expressOrder.requiredEnvironment.includes("ORDER_TOPIC"));
  assert.ok(expressOrder.parameters.some((item) => item.in === "path" && item.name === "accountId"));
  assert.ok(expressOrder.parameters.some((item) => item.in === "query" && item.name === "include"));
  assert.ok(expressOrder.parameters.some((item) => item.in === "header" && item.name === "x-tenant"));
  assert.ok(expressOrder.parameters.some((item) => item.in === "cookie" && item.name === "session"));
  const expressBody = expressOrder.requestBody?.content["application/json"];
  assert.strictEqual(expressBody?.properties?.productId.type, "string");
  assert.strictEqual(expressBody?.properties?.productId.format, "uuid");
  assert.strictEqual(expressBody?.properties?.quantity.minimum, 1);
  assert.deepStrictEqual(expressBody?.properties?.status.enum, ["draft", "paid"]);
  assert.ok(expressBody?.required?.includes("idempotencyKey"));
  assert.ok(expressOrder.responses.some((response) => response.status === "201"));
  assert.ok(expressOrder.prisma.some((item) =>
    item.model === "order" && item.operation === "create" && item.relations.includes("user")
  ));

  const joiRoute = contract(contracts, "PUT", "/api/orders/:id/status");
  const joiBody = joiRoute.requestBody?.content["application/json"];
  assert.deepStrictEqual(joiBody?.properties?.status.enum, ["paid", "cancelled"]);
  assert.deepStrictEqual(joiBody?.required, ["status"]);

  const openApiOrder = contract(contracts, "PATCH", "/api/v1/orders/{id}");
  assert.strictEqual(openApiOrder.framework, "openapi");
  assert.strictEqual(openApiOrder.operationId, "updateOrder");
  assert.ok(openApiOrder.parameters.some((item) => item.in === "query" && item.name === "dryRun"));
  assert.ok(openApiOrder.parameters.some((item) => item.in === "header" && item.name === "x-tenant-id"));
  assert.ok(openApiOrder.parameters.some((item) => item.in === "cookie" && item.name === "session"));
  assert.strictEqual(openApiOrder.requestBody?.content["application/json"].ref, "#/components/schemas/UpdateOrder");
  assert.strictEqual(openApiOrder.responses[0].content["application/json"].ref, "#/components/schemas/Order");
  assert.ok(openApiOrder.security.some((item) => item.type === "bearer"));
  assert.deepStrictEqual(openApiOrder.roles, ["admin"]);

  const healthContracts = contracts.filter(
    (item) => item.method === "GET" && item.path === "/api/v1/health"
  );
  assert.strictEqual(healthContracts.length, 1);
  assert.ok(healthContracts[0].evidence.some((item) => item.startsWith("Merged ")));

  const upload = contract(contracts, "POST", "/api/v1/uploads");
  assert.strictEqual(
    upload.requestBody?.content["multipart/form-data"].properties?.document.type,
    "file"
  );

  const nextApp = contract(contracts, "GET", "/api/users/:id");
  assert.strictEqual(nextApp.framework, "next-app");
  assert.ok(nextApp.parameters.some((item) => item.in === "query" && item.name === "include"));
  assert.ok(nextApp.parameters.some((item) => item.in === "header" && item.name === "x-tenant"));
  assert.ok(nextApp.requiredEnvironment.includes("USER_SECRET"));
  assert.ok(nextApp.responses.some((response) => response.status === "200"));
  const nextAppPost = contract(contracts, "POST", "/api/users/:id");
  assert.deepStrictEqual(nextAppPost.roles, ["editor"]);
  assert.ok(nextAppPost.requestBody?.content["application/json"]);

  const nextPages = contract(contracts, "POST", "/api/upload");
  assert.strictEqual(nextPages.framework, "next-pages");
  assert.strictEqual(nextPages.requestBody?.content["multipart/form-data"].properties?.avatar.type, "file");

  const requestGenerator = new RequestGenerator();
  const requestSuite = requestGenerator.generateRequestSuite(expressOrder, {
    variables: {
      accountId: "account/123",
      include: "items",
      "x-tenant": "tenant-1",
      session: "session-1"
    },
    headers: { Authorization: "Bearer access-token" }
  });
  assert.ok(requestSuite.valid.config.url.startsWith("/api/orders/account%2F123?"));
  assert.ok(requestSuite.valid.config.url.includes("include=items"));
  assert.strictEqual(requestSuite.valid.config.headers?.["x-tenant"], "tenant-1");
  assert.ok(requestSuite.valid.config.headers?.Cookie.includes("session=session-1"));
  const generatedQuantity = (requestSuite.valid.config.payload as Record<string, unknown>).quantity;
  assert.strictEqual(typeof generatedQuantity, "number");
  assert.ok((generatedQuantity as number) >= 1 && (generatedQuantity as number) <= 25);
  assert.ok(requestSuite.negative.some((variant) => variant.kind === "missing-field"));
  assert.ok(requestSuite.negative.some((variant) => variant.kind === "invalid-type"));
  assert.ok(requestSuite.negative.some((variant) => variant.kind === "boundary"));
  assert.ok(requestSuite.negative.some((variant) => variant.kind === "unauthorized"));
  assert.ok(requestSuite.negative.some((variant) => variant.kind === "forbidden"));
  assert.ok(requestSuite.negative.some((variant) =>
    variant.kind === "duplicate" && variant.repetitions === 2
  ));
  assert.ok(requestSuite.negative.some((variant) =>
    variant.kind === "malformed" && variant.config.bodyEncoding === "raw"
  ));

  const uploadRequest = requestGenerator.generateValidRequest(upload);
  assert.strictEqual(uploadRequest.config.bodyEncoding, "multipart");
  assert.strictEqual(
    ((uploadRequest.config.payload as Record<string, unknown>).document as Record<string, unknown>).filename,
    "document.txt"
  );

  const authContracts = createAuthContracts();
  const authCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const auth = new AuthBootstrapper("http://fixture.local", {
    credentialsFactory: () => ({
      username: "opspilot@example.com",
      password: "StrongPassword42!",
      profile: { role: "admin" }
    }),
    request: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      authCalls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      });
      if (url.endsWith("/auth/register")) {
        return new Response(JSON.stringify({ id: "user-1" }), {
          status: 201,
          headers: { "set-cookie": "registration=ok; Path=/; HttpOnly" }
        });
      }
      return new Response(JSON.stringify({
        data: { accessToken: "access-123" },
        refresh_token: "refresh-123"
      }), {
        status: 200,
        headers: { "set-cookie": "session=session-123; Path=/; HttpOnly" }
      });
    }) as typeof fetch
  });
  const authSession = await auth.bootstrapAuth(authContracts, "admin");
  assert.strictEqual(authCalls.length, 2);
  assert.strictEqual(authCalls[0].body.email, "opspilot@example.com");
  assert.strictEqual(authCalls[0].body.role, "admin");
  assert.strictEqual(authSession?.accessToken, "access-123");
  assert.strictEqual(authSession?.refreshToken, "refresh-123");
  assert.ok(authSession?.cookies.includes("session=session-123"));
  assert.strictEqual(
    auth.getAuthHeaders(authContracts[1]).Authorization,
    "Bearer access-123"
  );
  const missingAuth = new AuthBootstrapper("http://fixture.local");
  assert.strictEqual(await missingAuth.bootstrapAuth([expressOrder], "admin"), null);

  const planner = new StatefulWorkflowPlanner("http://fixture.local");
  const plan = await planner.planWorkflow(
    "project-stateful",
    [...authContracts, ...createLifecycleContracts()]
  );
  assert.ok(plan.steps.some((step) => step.id === "step-auth-register"));
  assert.ok(plan.steps.some((step) => step.id === "step-auth-login"));
  const projectCreate = plan.steps.find((step) => step.name === "Create Projects");
  const orderCreate = plan.steps.find((step) => step.name === "Create Orders");
  assert.ok(projectCreate);
  assert.ok(orderCreate);
  assert.ok((orderCreate.config.dependsOn as string[]).includes(projectCreate.id));
  assert.strictEqual(orderCreate.config.url, "/projects/${projects.id}/orders");
  assert.strictEqual(
    (orderCreate.config.payload as Record<string, unknown>).projectId,
    "${projects.id}"
  );
  assert.ok(plan.variables["projects.id"]);
  assert.ok(plan.variables["orders.id"]);
  assert.strictEqual(plan.cleanupSteps[0].name, "Delete Orders");
  assert.ok(plan.alternativePaths.some((path) => path.name.includes("Orders")));

  const scaleRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "opspilot-workflow-scale-"));
  await write(scaleRoot, "routes.ts", `
import { Router } from "express";
const router = Router();
${Array.from({ length: 500 }, (_, index) =>
    `router.get("/resources/${index}", (_req, res) => res.status(200).json({ id: ${index} }));`
  ).join("\n")}
export default router;
`);
  const scaleContracts = await discoverer.discoverContracts(scaleRoot);
  assert.strictEqual(scaleContracts.length, 500);
  await fs.promises.rm(scaleRoot, { recursive: true, force: true });

  const drivers = new WorkflowDrivers("http://localhost:4000", {
    execute: async (_config, correlationId) => ({
      success: true,
      log: `Playwright fixture completed [correlationId=${correlationId}]`
    })
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 201,
    text: async () => JSON.stringify({ success: true })
  } as Response);
  const httpResult = await drivers.executeHTTPStep({
    method: "POST",
    url: "/api/orders",
    expectedStatus: 201
  });
  assert.strictEqual(httpResult.success, true);
  assert(httpResult.correlationId);
  globalThis.fetch = originalFetch;

  const browserResult = await drivers.executeBrowserStep({ action: "navigate", url: "/orders" });
  assert.strictEqual(browserResult.success, true);

  // Test native WebSocket connection error handling
  const wsResult = await drivers.executeWebSocketStep({
    url: "ws://localhost:9999",
    action: "emit",
    event: "test",
    payload: { hello: "world" },
    timeoutMs: 100
  });
  assert.strictEqual(wsResult.success, false);
  assert.ok(wsResult.log.includes("failed") || wsResult.log.includes("Timeout"));

  const assertions = new AssertionEngine({
    database: async () => ({ success: true, log: "database fixture" }),
    queue: async () => ({ success: true, log: "queue fixture" }),
    sdk: async () => ({ success: true, log: "sdk fixture" })
  });
  assert.strictEqual((await assertions.assertDBState({ query: "SELECT 1" })).success, true);
  assert.strictEqual((await assertions.assertQueueEvent({
    queueName: "orders",
    event: "order.created"
  })).success, true);
  assert.strictEqual((await assertions.assertSDKState({ sdk: "Stripe", action: "invoice_exists" })).success, true);
  
  const unconfiguredAssertions = new AssertionEngine();
  
  // Test finding table names with casing and pluralization mapping
  const testTableNames = ["users", "orders", "Products", "user_profiles"];
  assert.strictEqual(
    (unconfiguredAssertions as any).findMatchingTableName(testTableNames, "User"),
    "users"
  );
  assert.strictEqual(
    (unconfiguredAssertions as any).findMatchingTableName(testTableNames, "order"),
    "orders"
  );
  assert.strictEqual(
    (unconfiguredAssertions as any).findMatchingTableName(testTableNames, "Product"),
    "Products"
  );
  assert.strictEqual(
    (unconfiguredAssertions as any).findMatchingTableName(testTableNames, "UserProfile"),
    "user_profiles"
  );

  assert.strictEqual(
    (await unconfiguredAssertions.assertSDKState({
      sdk: "Stripe",
      action: "invoice_exists"
    })).success,
    false
  );
  assert.strictEqual(
    (await unconfiguredAssertions.assertDBState({
      action: "cleanup",
      table: "orders"
    })).success,
    false
  );

  const correlation = new CorrelationManager(true);
  const runId = await correlation.startWorkflowRun("wf-123");
  await correlation.recordStepRun(runId, "step-1", "COMPLETED", ["passed"]);
  await correlation.completeWorkflowRun(runId, "COMPLETED");

  const localizer = new FailureLocalizer(true);
  const boundaryId = await localizer.localizeFailure(runId, "POST /api/orders", "HTTP 500");
  assert(boundaryId.startsWith("fb-"));

  await fs.promises.rm(repositoryRoot, { recursive: true, force: true });
  console.log("ALL WORKFLOW ENGINE TESTS PASSED");
}

function createAuthContracts() {
  const common = {
    framework: "openapi" as const,
    source: { file: "openapi.yaml", line: 1 },
    tags: ["auth"],
    parameters: [],
    responses: [],
    security: [],
    middleware: [],
    requiredEnvironment: [],
    roles: [],
    permissions: [],
    prisma: [],
    evidence: ["test fixture"],
    confidence: 1
  };
  const credentialBody = {
    required: true,
    source: "openapi.yaml",
    content: {
      "application/json": {
        type: "object" as const,
        required: ["email", "password"],
        properties: {
          email: { type: "string" as const, format: "email" },
          password: { type: "string" as const, minLength: 12 },
          role: { type: "string" as const }
        }
      }
    }
  };
  return [
    EndpointContractSchema.parse({
      ...common,
      id: "POST /auth/register",
      method: "POST",
      path: "/auth/register",
      summary: "Register user",
      requestBody: credentialBody,
      responses: [{ status: "201", headers: {}, content: {} }]
    }),
    EndpointContractSchema.parse({
      ...common,
      id: "POST /auth/login",
      method: "POST",
      path: "/auth/login",
      summary: "Login",
      requestBody: credentialBody,
      responses: [{ status: "200", headers: {}, content: {} }],
      security: [{
        scheme: "bearerAuth",
        type: "bearer",
        scopes: [],
        source: "openapi.yaml"
      }],
      roles: ["admin"]
    })
  ];
}

function createLifecycleContracts() {
  const createContract = (
    id: string,
    method: string,
    routePath: string,
    bodyProperties: Record<string, unknown> = {},
    required: string[] = []
  ) => EndpointContractSchema.parse({
    id,
    method,
    path: routePath,
    framework: "openapi",
    source: { file: "openapi.yaml", line: 1 },
    tags: [],
    parameters: [...routePath.matchAll(/{([^}]+)}/g)].map((match) => ({
      name: match[1],
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
      source: "openapi.yaml"
    })),
    requestBody: Object.keys(bodyProperties).length ? {
      required: true,
      source: "openapi.yaml",
      content: {
        "application/json": {
          type: "object",
          required,
          properties: bodyProperties
        }
      }
    } : undefined,
    responses: [{
      status: method === "POST" ? "201" : method === "DELETE" ? "204" : "200",
      headers: {},
      content: method === "DELETE" ? {} : {
        "application/json": {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", format: "uuid" } }
        }
      }
    }],
    security: [{
      scheme: "bearerAuth",
      type: "bearer",
      scopes: [],
      source: "openapi.yaml"
    }],
    middleware: [],
    requiredEnvironment: [],
    roles: [],
    permissions: [],
    prisma: [],
    evidence: ["test fixture"],
    confidence: 1
  });
  return [
    createContract(
      "create-project",
      "POST",
      "/projects",
      { name: { type: "string", minLength: 1 } },
      ["name"]
    ),
    createContract("read-project", "GET", "/projects/{projectId}"),
    createContract("delete-project", "DELETE", "/projects/{projectId}"),
    createContract(
      "create-order",
      "POST",
      "/projects/{projectId}/orders",
      {
        projectId: { type: "string", format: "uuid" },
        productId: { type: "string", format: "uuid" }
      },
      ["projectId", "productId"]
    ),
    createContract("read-order", "GET", "/projects/{projectId}/orders/{orderId}"),
    createContract("delete-order", "DELETE", "/projects/{projectId}/orders/{orderId}")
  ];
}

function contract(
  contracts: ReturnType<typeof EndpointContractSchema.parse>[],
  method: string,
  routePath: string
) {
  const result = contracts.find((item) => item.method === method && item.path === routePath);
  assert.ok(result, `Missing contract ${method} ${routePath}`);
  return result;
}

async function createContractFixture(root: string) {
  await write(root, "openapi.yaml", `
openapi: 3.1.0
info:
  title: Fixture API
  version: 1.0.0
servers:
  - url: /api/v1
security:
  - bearerAuth: []
paths:
  /health:
    get:
      summary: Health check
      responses:
        '200':
          description: Healthy
          content:
            application/json:
              schema:
                type: object
                required: [ok]
                properties:
                  ok: { type: boolean }
  /orders/{id}:
    patch:
      operationId: updateOrder
      summary: Update an order
      tags: [orders]
      x-roles: [admin]
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string, format: uuid }
        - name: dryRun
          in: query
          schema: { type: boolean }
        - name: x-tenant-id
          in: header
          required: true
          schema: { type: string }
        - name: session
          in: cookie
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/UpdateOrder'
      responses:
        '200':
          description: Updated order
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Order'
  /uploads:
    post:
      summary: Upload document
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema:
              type: object
              required: [document]
              properties:
                document: { type: string, format: binary }
                label: { type: string, minLength: 1 }
      responses:
        '201': { description: Uploaded }
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
  schemas:
    UpdateOrder:
      type: object
      required: [status]
      properties:
        status: { type: string, enum: [paid, cancelled] }
        note: { type: string, maxLength: 200 }
    Order:
      type: object
      required: [id, status]
      properties:
        id: { type: string, format: uuid }
        status: { type: string }
`);

  await write(root, "src/app.ts", `
import express from "express";
import apiRouter from "./routes/api.js";
import { authenticate } from "./middleware/auth.js";

const app = express();
app.use(authenticate);
app.use("/api", apiRouter);
app.get("/api/v1/health", (_req, res) => res.status(200).json({ ok: true }));
export default app;
`);

  await write(root, "src/routes/api.ts", `
import { Router } from "express";
import ordersRouter from "./orders.js";

const apiRouter = Router();
apiRouter.use("/orders", ordersRouter);
export default apiRouter;
`);

  await write(root, "src/middleware/auth.ts", `
import type { Request, Response, NextFunction } from "express";
export function authenticate(req: Request, _res: Response, next: NextFunction) {
  if (!process.env.JWT_SECRET) throw new Error("JWT secret missing");
  req.headers.authorization;
  next();
}
export const requireRole = (role: string) => (_req: Request, _res: Response, next: NextFunction) => next();
export const validateBody = (schema: any) => (req: Request, _res: Response, next: NextFunction) => {
  schema.parse(req.body);
  next();
};
`);

  await write(root, "src/schemas/order.ts", `
import { z } from "zod";
import Joi from "joi";

export const createOrderSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(25),
  status: z.enum(["draft", "paid"]),
  note: z.string().max(200).optional()
});

export const statusSchema = Joi.object({
  status: Joi.string().valid("paid", "cancelled").required(),
  reason: Joi.string().max(200).optional()
});
`);

  await write(root, "src/routes/orders.ts", `
import { Router, type Request, type Response } from "express";
import { body } from "express-validator";
import { requireRole, validateBody } from "../middleware/auth.js";
import { createOrderSchema, statusSchema } from "../schemas/order.js";
import { prisma } from "../services/prisma.js";

interface OrderParams { accountId: string }
interface OrderQuery { include?: string }
interface CreateOrderInput {
  productId: string;
  quantity: number;
  status: "draft" | "paid";
  note?: string;
}
interface OrderResponse { id: string; status: string }

const router = Router();

async function createOrder(
  req: Request<OrderParams, OrderResponse, CreateOrderInput, OrderQuery>,
  res: Response<OrderResponse>
) {
  req.get("x-tenant");
  req.headers["x-trace"];
  req.cookies.session;
  req.query.include;
  createOrderSchema.safeParse(req.body);
  const topic = process.env.ORDER_TOPIC;
  await prisma.order.create({ data: req.body, include: { user: true } });
  return res.status(201).json({ id: "order-id", status: "draft" });
}

router.post(
  "/:accountId",
  requireRole("admin"),
  validateBody(createOrderSchema),
  body("idempotencyKey").isUUID().notEmpty(),
  createOrder
);

router.put("/:id/status", validateBody(statusSchema), async (req, res) => {
  statusSchema.validate(req.body);
  return res.status(200).json({ id: req.params.id, status: req.body.status });
});

export default router;
`);

  await write(root, "src/services/prisma.ts", `
export const prisma: any = {};
`);

  await write(root, "prisma/schema.prisma", `
model User {
  id     String  @id
  orders Order[]
}

model Order {
  id     String @id
  userId String
  user   User   @relation(fields: [userId], references: [id])
}
`);

  await write(root, "src/app/api/users/[id]/route.ts", `
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const include = request.nextUrl.searchParams.get("include");
  const tenant = request.headers.get("x-tenant");
  const secret = process.env.USER_SECRET;
  return NextResponse.json({ id: "user-id", include, tenant, secret }, { status: 200 });
}

const withRole = (role: string, handler: (request: NextRequest) => Promise<Response>) => handler;
export const POST = withRole("editor", async (request: NextRequest) => {
  const body = await request.json();
  return NextResponse.json({ id: "created-user", body }, { status: 201 });
});
`);

  await write(root, "src/pages/api/upload.ts", `
import type { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  switch (req.method) {
    case "POST":
      req.file.avatar;
      return res.status(201).json({ uploaded: true });
    default:
      return res.status(405).end();
  }
}
`);
}

async function write(root: string, relativePath: string, content: string) {
  const absolute = path.join(root, relativePath);
  await fs.promises.mkdir(path.dirname(absolute), { recursive: true });
  await fs.promises.writeFile(absolute, content.trimStart());
}

runTests().catch((error) => {
  console.error("TEST RUN FAILED:", error);
  process.exit(1);
});
