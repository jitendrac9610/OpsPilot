import {
  Assertion,
  EndpointContract,
  WorkflowStep,
  WebSocketContract,
  WebhookContract,
  QueueContract,
  BrowserContract
} from "@opspilot/schemas";
import crypto from "node:crypto";
import { AuthBootstrapper } from "./authBootstrapper.js";
import {
  GeneratedRequestVariant,
  RequestGenerator
} from "./requestGenerator.js";
import { successfulStatus } from "./contractUtils.js";

export interface WorkflowAlternativePath {
  name: string;
  description: string;
  steps: WorkflowStep[];
}

export interface SyntheticWorkflowPlan {
  name: string;
  description: string;
  steps: WorkflowStep[];
  cleanupSteps: WorkflowStep[];
  alternativePaths: WorkflowAlternativePath[];
  prerequisiteGraph: Record<string, string[]>;
  variables: Record<string, { sourceStep: string; jsonPaths: string[] }>;
  initialVariables: Record<string, unknown>;
}

interface ResourceLifecycle {
  name: string;
  create?: EndpointContract;
  read?: EndpointContract;
  update?: EndpointContract;
  delete?: EndpointContract;
  dependencies: string[];
}

export class StatefulWorkflowPlanner {
  private readonly authBootstrapper: AuthBootstrapper;
  private readonly requestGenerator: RequestGenerator;

  constructor(baseApiUrl = "http://localhost:4000") {
    this.authBootstrapper = new AuthBootstrapper(baseApiUrl);
    this.requestGenerator = new RequestGenerator();
  }

  public async planWorkflow(
    projectId: string,
    contracts: EndpointContract[],
    wsContracts: WebSocketContract[] = [],
    webhookContracts: WebhookContract[] = [],
    queueContracts: QueueContract[] = [],
    browserContracts: BrowserContract[] = []
  ): Promise<SyntheticWorkflowPlan> {
    const steps: WorkflowStep[] = [];
    const cleanupSteps: WorkflowStep[] = [];
    const alternativePaths: WorkflowAlternativePath[] = [];
    const prerequisiteGraph: Record<string, string[]> = {};
    const variables: SyntheticWorkflowPlan["variables"] = {};
    const initialVariables = createInitialVariables(projectId, contracts);
    const endpoints = this.authBootstrapper.findAuthEndpoints(contracts);
    const authStepIds = this.planAuthentication(endpoints, steps, prerequisiteGraph);
    const lifecycles = orderLifecycles(groupContractsByResource(contracts));
    const createSteps = new Map<string, string>();
    let stepCounter = steps.length + 1;

    for (const lifecycle of lifecycles) {
      const dependencySteps = lifecycle.dependencies
        .map((dependency) => createSteps.get(dependency))
        .filter((value): value is string => Boolean(value));
      const authDependency = authStepIds.login ? [authStepIds.login] : [];
      let previousSteps = [...new Set([...authDependency, ...dependencySteps])];

      if (lifecycle.create) {
        const createContract = lifecycle.create;
        const createId = `step-${stepCounter++}`;
        const request = this.generateContractRequest(
          createContract,
          lifecycle,
          lifecycles
        );
        const variableName = `${lifecycle.name}.id`;
        const step = httpStep(
          createId,
          `Create ${humanize(lifecycle.name)}`,
          request,
          createContract,
          previousSteps,
          {
            [variableName]: responseIdPaths(lifecycle.create)
          }
        );
        steps.push(step);
        prerequisiteGraph[createId] = previousSteps;
        variables[variableName] = {
          sourceStep: createId,
          jsonPaths: responseIdPaths(lifecycle.create)
        };
        createSteps.set(lifecycle.name, createId);
        previousSteps = [createId];

        // WebSocket integration
        for (const wsContract of wsContracts) {
          for (const event of wsContract.events) {
            if (
              shareSignificantWord(lifecycle.name, event.name) ||
              shareSignificantWord(createContract.path, event.name)
            ) {
              let currentPrevious = createId;

              // Join room first if rooms exist
              if (event.rooms && event.rooms.length > 0) {
                const roomName = resolveRoomTemplate(event.rooms[0], lifecycle.name);
                const joinStepId = `step-${stepCounter++}`;
                steps.push({
                  id: joinStepId,
                  name: `Join WebSocket Room: ${roomName}`,
                  type: "WEBSOCKET_OPEN",
                  config: {
                    url: wsContract.url || "ws://localhost:4000",
                    namespace: wsContract.namespaces[0],
                    action: "join_room",
                    room: roomName,
                    dependsOn: [currentPrevious]
                  },
                  assertions: []
                });
                prerequisiteGraph[joinStepId] = [currentPrevious];
                currentPrevious = joinStepId;
              }

              // Listen or Emit event
              if (event.direction === "server-to-client") {
                const listenStepId = `step-${stepCounter++}`;
                steps.push({
                  id: listenStepId,
                  name: `Listen for WebSocket Event: ${event.name}`,
                  type: "WEBSOCKET_OPEN",
                  config: {
                    url: wsContract.url || "ws://localhost:4000",
                    namespace: wsContract.namespaces[0],
                    action: "listen",
                    event: event.name,
                    timeoutMs: 5000,
                    dependsOn: [currentPrevious]
                  },
                  assertions: []
                });
                prerequisiteGraph[listenStepId] = [currentPrevious];
                currentPrevious = listenStepId;
              } else if (event.direction === "client-to-server") {
                const emitStepId = `step-${stepCounter++}`;
                steps.push({
                  id: emitStepId,
                  name: `Emit WebSocket Event: ${event.name}`,
                  type: "WEBSOCKET_OPEN",
                  config: {
                    url: wsContract.url || "ws://localhost:4000",
                    namespace: wsContract.namespaces[0],
                    action: "emit",
                    event: event.name,
                    payload: {},
                    dependsOn: [currentPrevious]
                  },
                  assertions: []
                });
                prerequisiteGraph[emitStepId] = [currentPrevious];
                currentPrevious = emitStepId;
              }

              previousSteps = [currentPrevious];
            }
          }
        }

        // Webhook integration
        for (const webhookContract of webhookContracts) {
          if (isWebhookRelevant(lifecycle.name, createContract.path, webhookContract)) {
            let currentPrevious = previousSteps[0] || createId;
            const event = webhookContract.eventTypes[0] || "custom_event";

            const payload: Record<string, any> = {
              id: `evt_test_${crypto.randomBytes(4).toString("hex")}`,
              type: event,
              data: {
                object: {
                  id: `\${${lifecycle.name}.id}`,
                  amount: 1000,
                  currency: "usd"
                }
              }
            };

            if (webhookContract.provider === "github") {
              payload.action = "completed";
              payload.repository = { name: projectId };
              payload.sender = { login: "opspilot-tester" };
            }

            const webhookStepId = `step-${stepCounter++}`;
            steps.push({
              id: webhookStepId,
              name: `Simulate Webhook: ${webhookContract.provider} - ${event}`,
              type: "SIMULATE_WEBHOOK",
              config: {
                type: "incoming",
                endpointUrl: `\${baseApiUrl}${webhookContract.endpointUrl}`,
                provider: webhookContract.provider,
                secret: `\${process.env.${webhookContract.signingSecretEnvVar || "STRIPE_WEBHOOK_SECRET"}}`,
                payload,
                dependsOn: [currentPrevious]
              },
              assertions: []
            });

            prerequisiteGraph[webhookStepId] = [currentPrevious];
            currentPrevious = webhookStepId;
            previousSteps = [currentPrevious];
          }
        }

        // Queue/Worker integration
        for (const queueContract of queueContracts) {
          if (
            shareSignificantWord(lifecycle.name, queueContract.name) ||
            shareSignificantWord(createContract.path, queueContract.name)
          ) {
            let currentPrevious = previousSteps[0] || createId;
            const singularName = singular(lifecycle.name);
            const idVar = `\${${lifecycle.name}.id}`;
            const payloadContains: Record<string, any> = {
              [`${singularName}Id`]: idVar
            };

            const queueStepId = `step-${stepCounter++}`;
            steps.push({
              id: queueStepId,
              name: `Wait for BullMQ Job: ${queueContract.name}`,
              type: "WAIT_FOR_JOB",
              config: {
                queueName: queueContract.name,
                state: "completed",
                payloadContains,
                dependsOn: [currentPrevious]
              },
              assertions: []
            });

            prerequisiteGraph[queueStepId] = [currentPrevious];
            currentPrevious = queueStepId;
            previousSteps = [currentPrevious];
          }
        }

        // Browser integration
        for (const browserContract of browserContracts) {
          if (
            shareSignificantWord(lifecycle.name, browserContract.path) ||
            shareSignificantWord(createContract.path, browserContract.path)
          ) {
            let currentPrevious = previousSteps[0] || createId;

            // 1. Navigate to the page
            const navStepId = `step-${stepCounter++}`;
            steps.push({
              id: navStepId,
              name: `Navigate to ${browserContract.path}`,
              type: "BROWSER_ACTION",
              config: {
                action: "navigate",
                url: browserContract.path,
                dependsOn: [currentPrevious]
              },
              assertions: []
            });
            prerequisiteGraph[navStepId] = [currentPrevious];
            currentPrevious = navStepId;

            // 2. Interact with inputs, selects, checkboxes, buttons
            for (const element of browserContract.elements) {
              if (element.type === "input") {
                const fillStepId = `step-${stepCounter++}`;
                steps.push({
                  id: fillStepId,
                  name: `Fill ${element.name || "input"} on ${browserContract.path}`,
                  type: "BROWSER_ACTION",
                  config: {
                    action: "fill",
                    selector: element.selector,
                    text: `test-${element.name || "input"}`,
                    dependsOn: [currentPrevious]
                  },
                  assertions: []
                });
                prerequisiteGraph[fillStepId] = [currentPrevious];
                currentPrevious = fillStepId;
              } else if (element.type === "select") {
                const selectStepId = `step-${stepCounter++}`;
                steps.push({
                  id: selectStepId,
                  name: `Select option in ${element.name || "select"} on ${browserContract.path}`,
                  type: "BROWSER_ACTION",
                  config: {
                    action: "select",
                    selector: element.selector,
                    value: "1",
                    dependsOn: [currentPrevious]
                  },
                  assertions: []
                });
                prerequisiteGraph[selectStepId] = [currentPrevious];
                currentPrevious = selectStepId;
              } else if (element.type === "checkbox") {
                const checkStepId = `step-${stepCounter++}`;
                steps.push({
                  id: checkStepId,
                  name: `Check checkbox in ${element.name || "checkbox"} on ${browserContract.path}`,
                  type: "BROWSER_ACTION",
                  config: {
                    action: "check",
                    selector: element.selector,
                    dependsOn: [currentPrevious]
                  },
                  assertions: []
                });
                prerequisiteGraph[checkStepId] = [currentPrevious];
                currentPrevious = checkStepId;
              } else if (element.type === "button") {
                const clickStepId = `step-${stepCounter++}`;
                steps.push({
                  id: clickStepId,
                  name: `Click ${element.label || "button"} on ${browserContract.path}`,
                  type: "BROWSER_ACTION",
                  config: {
                    action: "click",
                    selector: element.selector,
                    dependsOn: [currentPrevious]
                  },
                  assertions: []
                });
                prerequisiteGraph[clickStepId] = [currentPrevious];
                currentPrevious = clickStepId;
              }
            }

            previousSteps = [currentPrevious];
          }
        }

        const negativeSteps = this.requestGenerator
          .generateRequestSuite(createContract, {
            variables: requestVariables(lifecycle, lifecycles),
            headers: authHeaders(createContract)
          })
          .negative
          .filter((variant) =>
            ["missing-field", "invalid-type", "unauthorized", "forbidden", "duplicate"]
              .includes(variant.kind)
          )
          .slice(0, 6)
          .map((variant, index) =>
            variantStep(
              `alternative-${lifecycle.name}-${index + 1}`,
              variant,
              createContract,
              authDependency
            )
          );
        if (negativeSteps.length) {
          alternativePaths.push({
            name: `${humanize(lifecycle.name)} validation and authorization`,
            description: `Failure-path requests derived from the ${createContract.method} ${createContract.path} contract.`,
            steps: negativeSteps
          });
        }
      }

      for (const [operation, contract] of [
        ["Read", lifecycle.read],
        ["Update", lifecycle.update]
      ] as const) {
        if (!contract) continue;
        const stepId = `step-${stepCounter++}`;
        const request = this.generateContractRequest(contract, lifecycle, lifecycles);
        steps.push(httpStep(
          stepId,
          `${operation} ${humanize(lifecycle.name)}`,
          request,
          contract,
          previousSteps
        ));
        prerequisiteGraph[stepId] = previousSteps;
        previousSteps = [stepId];
      }

      if (lifecycle.delete) {
        const cleanupId = `cleanup-${lifecycle.name}`;
        const request = this.generateContractRequest(
          lifecycle.delete,
          lifecycle,
          lifecycles
        );
        cleanupSteps.unshift(httpStep(
          cleanupId,
          `Delete ${humanize(lifecycle.name)}`,
          request,
          lifecycle.delete,
          createSteps.get(lifecycle.name) ? [createSteps.get(lifecycle.name)!] : []
        ));
      }
    }

    if (steps.length === 0 || (steps.length === authStepIds.count && contracts.length > 0)) {
      for (const contract of contracts.filter((item) => !isAuthContract(item)).slice(0, 5)) {
        const stepId = `step-${stepCounter++}`;
        const request = this.requestGenerator.generateValidRequest(contract, {
          headers: authHeaders(contract)
        });
        const dependencies = authStepIds.login ? [authStepIds.login] : [];
        steps.push(httpStep(
          stepId,
          `${contract.method} ${contract.path}`,
          request,
          contract,
          dependencies
        ));
        prerequisiteGraph[stepId] = dependencies;
      }
    }

    return {
      name: `Stateful contract workflow for ${projectId}`,
      description: "Authentication, prerequisite resources, dependent requests, negative paths, and reverse-order cleanup generated from discovered endpoint contracts.",
      steps,
      cleanupSteps,
      alternativePaths,
      prerequisiteGraph,
      variables,
      initialVariables
    };
  }

  private planAuthentication(
    endpoints: ReturnType<AuthBootstrapper["findAuthEndpoints"]>,
    steps: WorkflowStep[],
    prerequisiteGraph: Record<string, string[]>
  ): { register?: string; login?: string; count: number } {
    let registerId: string | undefined;
    let loginId: string | undefined;
    if (endpoints.register) {
      registerId = "step-auth-register";
      const request = this.requestGenerator.generateValidRequest(endpoints.register, {
        variables: authVariableTemplates()
      });
      steps.push(httpStep(
        registerId,
        "Create isolated test user",
        request,
        endpoints.register,
        [],
        {
          "auth.userId": ["$.id", "$.user.id", "$.data.id", "$.data.user.id"]
        },
        "CREATE_USER"
      ));
      prerequisiteGraph[registerId] = [];
    }
    if (endpoints.login) {
      loginId = "step-auth-login";
      const request = this.requestGenerator.generateValidRequest(endpoints.login, {
        variables: authVariableTemplates()
      });
      const dependencies = registerId ? [registerId] : [];
      steps.push(httpStep(
        loginId,
        "Authenticate isolated test user",
        request,
        endpoints.login,
        dependencies,
        {
          "auth.accessToken": [
            "$.accessToken",
            "$.access_token",
            "$.token",
            "$.data.accessToken",
            "$.data.token"
          ],
          "auth.refreshToken": [
            "$.refreshToken",
            "$.refresh_token",
            "$.data.refreshToken"
          ]
        },
        "AUTHENTICATE"
      ));
      prerequisiteGraph[loginId] = dependencies;
    }
    return {
      register: registerId,
      login: loginId,
      count: Number(Boolean(registerId)) + Number(Boolean(loginId))
    };
  }

  private generateContractRequest(
    contract: EndpointContract,
    lifecycle: ResourceLifecycle,
    lifecycles: ResourceLifecycle[]
  ): GeneratedRequestVariant {
    const generated = this.requestGenerator.generateValidRequest(contract, {
      variables: requestVariables(lifecycle, lifecycles),
      headers: authHeaders(contract)
    });
    generated.config.url = templatePath(
      contract,
      lifecycle,
      lifecycles,
      generated.config.url
    );
    return generated;
  }
}

function groupContractsByResource(contracts: EndpointContract[]): ResourceLifecycle[] {
  const groups = new Map<string, ResourceLifecycle>();
  for (const contract of contracts) {
    if (isAuthContract(contract)) continue;
    const name = resourceName(contract.path);
    if (!name) continue;
    const group = groups.get(name) || { name, dependencies: [] };
    const itemRoute = /\/(?::[^/]+|{[^/]+})\/?$/.test(contract.path);
    if (contract.method === "POST" && !itemRoute && !isActionRoute(contract.path) && !group.create) {
      group.create = contract;
    } else if (contract.method === "GET" && itemRoute && !group.read) {
      group.read = contract;
    } else if (["PUT", "PATCH"].includes(contract.method) && itemRoute && !group.update) {
      group.update = contract;
    } else if (contract.method === "DELETE" && itemRoute && !group.delete) {
      group.delete = contract;
    }
    groups.set(name, group);
  }

  const lifecycles = [...groups.values()];
  for (const lifecycle of lifecycles) {
    const schema = lifecycle.create?.requestBody?.content["application/json"];
    const fields = Object.keys(schema?.properties || {});
    lifecycle.dependencies = [...new Set(fields.flatMap((field) => {
      const normalized = normalizeResource(field.replace(/_?id$/i, ""));
      if (!/_?id$/i.test(field)) return [];
      const dependency = lifecycles.find((candidate) =>
        candidate.name !== lifecycle.name &&
        [candidate.name, singular(candidate.name)].includes(normalized)
      );
      return dependency ? [dependency.name] : [];
    }))];
  }
  return lifecycles;
}

function orderLifecycles(lifecycles: ResourceLifecycle[]): ResourceLifecycle[] {
  const byName = new Map(lifecycles.map((lifecycle) => [lifecycle.name, lifecycle]));
  const ordered: ResourceLifecycle[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (lifecycle: ResourceLifecycle) => {
    if (visited.has(lifecycle.name)) return;
    if (visiting.has(lifecycle.name)) {
      lifecycle.dependencies = lifecycle.dependencies.filter((dependency) => !visiting.has(dependency));
      return;
    }
    visiting.add(lifecycle.name);
    lifecycle.dependencies.forEach((dependency) => {
      const prerequisite = byName.get(dependency);
      if (prerequisite) visit(prerequisite);
    });
    visiting.delete(lifecycle.name);
    visited.add(lifecycle.name);
    ordered.push(lifecycle);
  };

  lifecycles
    .sort((a, b) => lifecycleScore(b) - lifecycleScore(a) || a.name.localeCompare(b.name))
    .forEach(visit);
  return ordered;
}

function lifecycleScore(lifecycle: ResourceLifecycle): number {
  return [lifecycle.create, lifecycle.read, lifecycle.update, lifecycle.delete]
    .filter(Boolean)
    .length;
}

function requestVariables(
  lifecycle: ResourceLifecycle,
  lifecycles: ResourceLifecycle[]
): Record<string, unknown> {
  const variables: Record<string, unknown> = {};
  variables.id = `\${${lifecycle.name}.id}`;
  variables[`${singular(lifecycle.name)}Id`] = `\${${lifecycle.name}.id}`;
  variables[`${singular(lifecycle.name)}_id`] = `\${${lifecycle.name}.id}`;
  for (const dependencyName of lifecycle.dependencies) {
    variables[`${singular(dependencyName)}Id`] = `\${${dependencyName}.id}`;
    variables[`${singular(dependencyName)}_id`] = `\${${dependencyName}.id}`;
  }
  for (const candidate of lifecycles) {
    variables[`${singular(candidate.name)}Id`] ??= `\${${candidate.name}.id}`;
  }
  return variables;
}

function templatePath(
  contract: EndpointContract,
  lifecycle: ResourceLifecycle,
  lifecycles: ResourceLifecycle[],
  generatedUrl: string
): string {
  const queryIndex = generatedUrl.indexOf("?");
  const query = queryIndex >= 0 ? generatedUrl.slice(queryIndex) : "";
  let result = contract.path;
  const pathParameters = contract.parameters.filter((parameter) => parameter.in === "path");
  const inferred = [...result.matchAll(/:([A-Za-z0-9_]+)|{([A-Za-z0-9_]+)}/g)]
    .map((match) => match[1] || match[2]);
  for (const name of new Set([...pathParameters.map((parameter) => parameter.name), ...inferred])) {
    const owner = variableOwner(name, lifecycle, lifecycles);
    const replacement = `\${${owner}.id}`;
    result = result
      .replace(new RegExp(`:${escapeRegex(name)}\\b`, "g"), replacement)
      .replace(new RegExp(`{${escapeRegex(name)}}`, "g"), replacement);
  }
  return `${result}${query}`;
}

function variableOwner(
  parameterName: string,
  lifecycle: ResourceLifecycle,
  lifecycles: ResourceLifecycle[]
): string {
  const stem = normalizeResource(parameterName.replace(/_?id$/i, ""));
  const explicit = lifecycles.find((candidate) =>
    [candidate.name, singular(candidate.name)].includes(stem)
  );
  return explicit?.name || lifecycle.name;
}

function authHeaders(contract: EndpointContract): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const security of contract.security) {
    if (security.type === "bearer" || security.type === "oauth2") {
      headers.Authorization = "Bearer ${auth.accessToken}";
    } else if (security.type === "basic") {
      headers.Authorization = "Basic ${auth.basicCredentials}";
    } else if (security.type === "cookie" || security.type === "session") {
      headers.Cookie = "${auth.cookie}";
    } else if (security.type === "apiKey" && security.in !== "query") {
      headers[security.name || "x-api-key"] = "${auth.apiKey}";
    }
  }
  if (
    Object.keys(headers).length === 0 &&
    (contract.roles.length > 0 || contract.permissions.length > 0)
  ) {
    headers.Authorization = "Bearer ${auth.accessToken}";
  }
  return headers;
}

function createInitialVariables(
  projectId: string,
  contracts: EndpointContract[]
): Record<string, unknown> {
  const suffix = crypto.randomBytes(5).toString("hex");
  const role = contracts.flatMap((contract) => contract.roles)[0] || "user";
  return {
    "auth.email": `opspilot.${safeId(projectId).toLowerCase()}.${suffix}@example.com`,
    "auth.password": `OpsPilot-${suffix}-Aa1!`,
    "auth.role": role
  };
}

function authVariableTemplates(): Record<string, unknown> {
  return {
    email: "${auth.email}",
    username: "${auth.email}",
    login: "${auth.email}",
    password: "${auth.password}",
    role: "${auth.role}",
    name: "OpsPilot Test User"
  };
}

function httpStep(
  id: string,
  name: string,
  request: GeneratedRequestVariant,
  contract: EndpointContract,
  dependsOn: string[],
  extractVariables?: Record<string, string[]>,
  type: WorkflowStep["type"] = "HTTP_REQUEST"
): WorkflowStep {
  return {
    id,
    name,
    type,
    config: {
      ...request.config,
      contractId: contract.id,
      dependsOn,
      ...(extractVariables ? { extractVariables } : {})
    },
    assertions: defaultAssertions(contract)
  };
}

function variantStep(
  id: string,
  variant: GeneratedRequestVariant,
  contract: EndpointContract,
  dependsOn: string[]
): WorkflowStep {
  return {
    id,
    name: variant.description,
    type: "HTTP_REQUEST",
    config: {
      ...variant.config,
      variant: variant.kind,
      repetitions: variant.repetitions || 1,
      contractId: contract.id,
      dependsOn
    },
    assertions: [{
      id: `assert-${id}-status`,
      type: "HTTP_RESPONSE",
      target: "status",
      condition: "EQUALS",
      expected: variant.config.expectedStatus
    }]
  };
}

function defaultAssertions(contract: EndpointContract): Assertion[] {
  const status = successfulStatus(contract.responses, contract.method);
  const assertions: Assertion[] = [{
    id: `assert-status-${safeId(contract.id)}`,
    type: "HTTP_RESPONSE",
    target: "status",
    condition: "EQUALS",
    expected: status
  }];
  const response = contract.responses.find((candidate) => candidate.status === String(status));
  const schema = response?.content["application/json"];
  if (schema) {
    assertions.push({
      id: `assert-schema-${safeId(contract.id)}`,
      type: "HTTP_RESPONSE",
      target: "body",
      condition: "MATCHES_SCHEMA",
      expected: schema
    });
  }
  return assertions;
}

function responseIdPaths(contract: EndpointContract): string[] {
  const success = contract.responses.find((response) => {
    const status = Number(response.status);
    return status >= 200 && status < 300;
  });
  const schema = success?.content["application/json"];
  const properties = schema?.properties || {};
  const directId = Object.keys(properties).find((name) => name === "id" || /Id$/.test(name));
  return [
    directId ? `$.${directId}` : "$.id",
    "$.data.id",
    "$.result.id",
    "$.data.result.id"
  ];
}

function isAuthContract(contract: EndpointContract): boolean {
  const text = `${contract.path} ${contract.summary || ""} ${contract.operationId || ""}`.toLowerCase();
  return ["/auth", "login", "signin", "register", "signup", "refresh", "/token"]
    .some((token) => text.includes(token));
}

function isActionRoute(routePath: string): boolean {
  const finalSegment = routePath.split("?")[0].split("/").filter(Boolean).at(-1)?.toLowerCase();
  return Boolean(finalSegment && [
    "cancel", "activate", "deactivate", "publish", "archive", "restore",
    "retry", "approve", "reject", "complete", "close", "open"
  ].includes(finalSegment));
}

function resourceName(routePath: string): string | undefined {
  const ignored = new Set([
    "api", "v1", "v2", "v3", "status", "cancel", "activate", "deactivate",
    "publish", "archive", "restore", "search", "health", "metrics"
  ]);
  const segments = routePath
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .filter((segment) => !segment.startsWith(":") && !segment.startsWith("{"))
    .map(normalizeResource)
    .filter((segment) => !ignored.has(segment));
  return segments.at(-1);
}

function normalizeResource(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function singular(value: string): string {
  if (value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.endsWith("ses")) return value.slice(0, -2);
  if (value.endsWith("s") && !value.endsWith("ss")) return value.slice(0, -1);
  return value;
}

function humanize(value: string): string {
  return value
    .split("-")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shareSignificantWord(a: string, b: string): boolean {
  const clean = (str: string) => str.toLowerCase().replace(/[^a-z0-9]/g, " ").split(/\s+/).filter(w => w.length >= 4);
  const wordsA = clean(a);
  const wordsB = clean(b);
  for (const wA of wordsA) {
    for (const wB of wordsB) {
      if (wA === wB || wA + "s" === wB || wB + "s" === wA || wA.slice(0, -1) === wB || wB.slice(0, -1) === wA) {
        return true;
      }
    }
  }
  return false;
}

function resolveRoomTemplate(room: string, resourceName: string): string {
  const match = room.match(/\d+/);
  if (match) {
    return room.replace(/\d+/, `\${${resourceName}.id}`);
  }
  return room;
}

function isWebhookRelevant(lifecycleName: string, createPath: string, webhook: WebhookContract): boolean {
  if (
    shareSignificantWord(lifecycleName, webhook.provider) ||
    shareSignificantWord(lifecycleName, webhook.endpointUrl) ||
    shareSignificantWord(createPath, webhook.endpointUrl)
  ) {
    return true;
  }

  const nameLower = lifecycleName.toLowerCase();
  const pathLower = createPath.toLowerCase();

  if (webhook.provider === "stripe" || webhook.provider === "razorpay") {
    const paymentKeywords = ["order", "payment", "checkout", "subscription", "billing", "invoice", "customer", "charge"];
    return paymentKeywords.some(keyword => nameLower.includes(keyword) || pathLower.includes(keyword));
  }

  if (webhook.provider === "github") {
    const githubKeywords = ["repo", "repository", "commit", "pull", "issue", "project", "build", "deploy", "workflow"];
    return githubKeywords.some(keyword => nameLower.includes(keyword) || pathLower.includes(keyword));
  }

  return false;
}

