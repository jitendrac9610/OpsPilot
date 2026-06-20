import { logger } from "./logger.js";

export interface EventEnvelope<T = any> {
  id: string;
  name: string;
  organizationId: string;
  projectId: string;
  environment: "development" | "staging" | "production" | "sandbox";
  sourceEntity: string;
  commitSha: string;
  correlationId: string;
  idempotencyKey: string;
  timestamp: string;
  data: T;
}

export type SystemEventName =
  | "repository.connected"
  | "repository.snapshot.created"
  | "capability.detected"
  | "workspace.discovered"
  | "service.discovered"
  | "indexing.started"
  | "indexing.completed"
  | "architecture.generated"
  | "analysis.started"
  | "finding.created"
  | "workflow.discovered"
  | "workflow.run.requested"
  | "workflow.step.started"
  | "workflow.step.completed"
  | "workflow.assertion.failed"
  | "workflow.failed"
  | "workflow.passed"
  | "failure.boundary.localized"
  | "agent.started"
  | "agent.replanned"
  | "agent.checkpoint.created"
  | "retrieval.retry.requested"
  | "retrieval.retry.completed"
  | "tool.retry.requested"
  | "model.retry.requested"
  | "diagnosis.completed"
  | "remediation.plan.created"
  | "sandbox.change.applied"
  | "verification.started"
  | "verification.failed"
  | "verification.passed"
  | "approval.requested"
  | "approval.approved"
  | "approved_action.started"
  | "approved_action.completed"
  | "recovery.failed"
  | "rollback.started"
  | "rollback.completed"
  | "postmortem.created"
  | "budget.exhausted"
  | "dead_letter.created";

export class EventBus {
  private static listeners: Map<string, Array<(event: EventEnvelope) => Promise<void>>> = new Map();

  static async publish(event: EventEnvelope): Promise<void> {
    logger.info({ eventName: event.name, eventId: event.id, correlationId: event.correlationId }, "Publishing event");
    const eventListeners = this.listeners.get(event.name) || [];
    const wildCardListeners = this.listeners.get("*") || [];
    
    const allListeners = [...eventListeners, ...wildCardListeners];
    
    const promises = allListeners.map(listener => 
      listener(event).catch(err => {
        logger.error({ err, eventName: event.name, eventId: event.id }, "Error in event listener");
      })
    );
    
    await Promise.all(promises);
  }

  static subscribe(eventName: SystemEventName | "*", handler: (event: EventEnvelope) => Promise<void>): void {
    const list = this.listeners.get(eventName) || [];
    list.push(handler);
    this.listeners.set(eventName, list);
  }
}
