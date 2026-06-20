export class OpsPilotError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details: any = null
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends OpsPilotError {
  constructor(message: string, details: any = null) {
    super(message, "VALIDATION_ERROR", 400, details);
  }
}

export class UnauthorizedError extends OpsPilotError {
  constructor(message: string = "Unauthorized access") {
    super(message, "UNAUTHORIZED", 401);
  }
}

export class ForbiddenError extends OpsPilotError {
  constructor(message: string = "Forbidden access") {
    super(message, "FORBIDDEN", 403);
  }
}

export class NotFoundError extends OpsPilotError {
  constructor(message: string) {
    super(message, "NOT_FOUND", 404);
  }
}

export class ConflictError extends OpsPilotError {
  constructor(message: string) {
    super(message, "CONFLICT", 409);
  }
}

export class SandboxError extends OpsPilotError {
  constructor(message: string, details: any = null) {
    super(message, "SANDBOX_ERROR", 500, details);
  }
}

export class AgentRuntimeError extends OpsPilotError {
  constructor(message: string, details: any = null) {
    super(message, "AGENT_RUNTIME_ERROR", 500, details);
  }
}
