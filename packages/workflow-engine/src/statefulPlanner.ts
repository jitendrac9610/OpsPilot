import {
  Assertion,
  EndpointContract,
  WorkflowStep
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
    contracts: EndpointContract[]
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
