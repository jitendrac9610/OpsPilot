import { logger } from "@opspilot/shared";

export interface PolicyContext {
  isProduction: boolean;
  userRole?: string;
  approvedActionIds?: string[];
}

export interface PolicyDecision {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
}

export class PolicyEngine {
  private highRiskProductionTools = new Set([
    "restart_service",
    "restart_deployment",
    "rollback_deployment",
    "apply_approved_changes",
    "merge_pr",
    "delete_database",
    "modify_production_config"
  ]);

  public evaluate(toolName: string, args: any, context: PolicyContext): PolicyDecision {
    logger.debug({ toolName, context }, "Evaluating tool execution policy");

    if (!context.isProduction) {
      return {
        allowed: true,
        requiresApproval: false,
        reason: "Allowed in sandbox mode without approval."
      };
    }

    if (this.highRiskProductionTools.has(toolName)) {
      const isApproved = context.approvedActionIds?.includes(args.id || args.approvalId || toolName);
      if (isApproved) {
        return {
          allowed: true,
          requiresApproval: false,
          reason: `High-risk tool ${toolName} execution allowed via pre-approved action ID.`
        };
      }

      return {
        allowed: false,
        requiresApproval: true,
        reason: `High-risk tool ${toolName} in production requires two-person human approval.`
      };
    }

    return {
      allowed: true,
      requiresApproval: false,
      reason: "Standard diagnostic or low-risk tool allowed in production."
    };
  }
}
