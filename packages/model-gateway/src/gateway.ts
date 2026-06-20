import { config } from "@opspilot/shared";
import { logger } from "@opspilot/shared";
import { AgentDecision, AgentDecisionSchema } from "@opspilot/schemas";

export interface GatewayCallOpts {
  systemInstruction?: string;
  temperature?: number;
  mockDecisions?: AgentDecision[];
}

export class ModelGateway {
  private apiKey: string;
  private defaultModel: string;
  private provider: "gemini" | "openrouter";
  private mockQueue: AgentDecision[] = [];

  constructor(opts?: { apiKey?: string; defaultModel?: string; provider?: "gemini" | "openrouter" }) {
    this.provider = opts?.provider || (config.geminiApiKey ? "gemini" : config.openrouterApiKey ? "openrouter" : "gemini");
    this.apiKey = opts?.apiKey || (this.provider === "openrouter" ? config.openrouterApiKey : config.geminiApiKey);
    this.defaultModel = opts?.defaultModel || (this.provider === "openrouter" ? "google/gemini-2.5-flash" : "gemini-1.5-flash");
  }

  public setMockDecisions(decisions: AgentDecision[]) {
    this.mockQueue = [...decisions];
  }

  public async generateDecision(
    prompt: string,
    state: string,
    opts?: GatewayCallOpts
  ): Promise<{ decision: AgentDecision; promptTokens: number; completionTokens: number }> {
    // Check if we should run in mock mode
    if (opts?.mockDecisions && opts.mockDecisions.length > 0) {
      const decision = opts.mockDecisions.shift()!;
      return { decision, promptTokens: 0, completionTokens: 0 };
    }
    if (this.mockQueue.length > 0) {
      const decision = this.mockQueue.shift()!;
      return { decision, promptTokens: 0, completionTokens: 0 };
    }

    if (!this.apiKey) {
      if (config.isDemoMode) {
        logger.warn(`ModelGateway: No API key configured for ${this.provider}; using clearly marked demo decisions.`);
        const decision = this.getMockDecisionForState(state);
        return { decision, promptTokens: 0, completionTokens: 0 };
      }
      throw new Error(`MODEL_PROVIDER_NOT_CONFIGURED: No API key configured for ${this.provider}.`);
    }

    if (this.provider === "openrouter") {
      try {
        const url = "https://openrouter.ai/api/v1/chat/completions";
        const payload = {
          model: this.defaultModel,
          messages: [
            ...(opts?.systemInstruction ? [{ role: "system", content: opts.systemInstruction }] : []),
            { role: "user", content: prompt }
          ],
          response_format: { type: "json_object" },
          temperature: opts?.temperature ?? 0.2,
          max_tokens: 1500
        };

        logger.info({ model: this.defaultModel }, "Calling OpenRouter API...");
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiKey}`,
            "HTTP-Referer": "https://opspilot.ai",
            "X-Title": "OpsPilot"
          },
          body: JSON.stringify(payload)
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`OpenRouter API returned status ${response.status}: ${errorText}`);
        }

        const responseData = (await response.json()) as any;
        const text = responseData.choices?.[0]?.message?.content;
        if (!text) {
          throw new Error("Empty response from OpenRouter API");
        }

        // Parse JSON
        const json = JSON.parse(text);
        const parsedDecision = AgentDecisionSchema.parse(json);

        const promptTokens = responseData.usage?.prompt_tokens ?? 100;
        const completionTokens = responseData.usage?.completion_tokens ?? 50;

        return {
          decision: parsedDecision,
          promptTokens,
          completionTokens
        };
      } catch (err: any) {
        logger.error({ err }, "OpenRouter API call failed");
        if (!config.isDemoMode) throw err;
        const decision = this.getMockDecisionForState(state);
        return { decision, promptTokens: 0, completionTokens: 0 };
      }
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.defaultModel}:generateContent?key=${this.apiKey}`;
      const payload = {
        contents: [
          {
            parts: [
              { text: prompt }
            ]
          }
        ],
        systemInstruction: opts?.systemInstruction ? {
          parts: [{ text: opts.systemInstruction }]
        } : undefined,
        generationConfig: {
          responseMimeType: "application/json",
          temperature: opts?.temperature ?? 0.2
        }
      };

      logger.info({ model: this.defaultModel }, "Calling Gemini API...");
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Gemini API returned status ${response.status}: ${errorText}`);
      }

      const responseData = (await response.json()) as any;
      const text = responseData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error("Empty response from Gemini API");
      }

      // Parse JSON
      const json = JSON.parse(text);
      const parsedDecision = AgentDecisionSchema.parse(json);

      // Extract usage metadata if available
      const promptTokens = responseData.usageMetadata?.promptTokenCount ?? 100;
      const completionTokens = responseData.usageMetadata?.candidatesTokenCount ?? 50;

      return {
        decision: parsedDecision,
        promptTokens,
        completionTokens
      };
    } catch (err: any) {
      logger.error({ err }, "Gemini API call failed");
      if (!config.isDemoMode) throw err;
      const decision = this.getMockDecisionForState(state);
      return { decision, promptTokens: 0, completionTokens: 0 };
    }
  }

  private getMockDecisionForState(state: string): AgentDecision {
    switch (state) {
      case "CREATED":
      case "DISCOVERING":
        return {
          type: "call_tool",
          tool: "list_services",
          arguments: {}
        };
      case "INDEXING":
        return {
          type: "call_tool",
          tool: "index_repository",
          arguments: {}
        };
      case "PLANNING":
        return {
          type: "replan",
          reason: "Need to check failure logs first"
        };
      case "RETRIEVING":
        return {
          type: "retrieve",
          request: { query: "failed builds or logs" }
        };
      case "INVESTIGATING":
        return {
          type: "call_tool",
          tool: "view_logs",
          arguments: { service: "api-service" }
        };
      case "LOCALIZING_FAILURE":
        return {
          type: "update_hypotheses",
          updates: [
            { description: "API-service fails due to connection reset from Auth-service", confidence: 75, status: "SUPPORTED" }
          ]
        };
      case "DIAGNOSING":
        return {
          type: "update_hypotheses",
          updates: [
            { description: "Auth-service fails due to missing environment variable DB_HOST", confidence: 90, status: "SUPPORTED" }
          ]
        };
      case "REPRODUCING":
        return {
          type: "call_tool",
          tool: "run_tests",
          arguments: { suite: "auth-service" }
        };
      case "PROPOSING_FIX":
        return {
          type: "propose_change",
          plan: {
            description: "Add DB_HOST variable to config",
            files: ["config.json"]
          }
        };
      case "APPLYING_SANDBOX_CHANGE":
        return {
          type: "call_tool",
          tool: "apply_patch",
          arguments: { file: "config.json", patch: "env.DB_HOST = localhost" }
        };
      case "VERIFYING_FIX":
        return {
          type: "request_approval",
          approval: {
            id: "appr-123",
            problem: "Missing DB_HOST env var in auth-service causing API connection reset",
            filesChanged: 1,
            risk: "LOW",
            verification: {
              originalFailureReproduced: true,
              buildPassed: true,
              workflowPassed: true,
              regressionTestsPassedCount: 5,
              securityRegressionDetected: false
            },
            actions: ["APPROVE_AND_PR"]
          }
        };
      case "AWAITING_APPROVAL":
        return {
          type: "call_tool",
          tool: "approve_action",
          arguments: { id: "appr-123" }
        };
      case "APPLYING_APPROVED_ACTION":
        return {
          type: "call_tool",
          tool: "apply_approved_changes",
          arguments: {}
        };
      case "MONITORING_RECOVERY":
        return {
          type: "complete",
          conclusion: {
            success: true,
            summary: "Successfully verified and fixed missing DB_HOST issue."
          }
        };
      default:
        return {
          type: "complete",
          conclusion: {
            success: true,
            summary: "Finished execution loop."
          }
        };
    }
  }
}
