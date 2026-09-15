// Request Payload Sanitizer & Parameter Stripper (prevents HTTP 400 on strict upstreams like NVIDIA NIM)
import type { ChatCompletionRequest, Provider } from "../types";

export class RequestSanitizer {
  /**
   * Sanitize and strip non-standard fields from OpenAI ChatCompletionRequest
   */
  static sanitize(req: ChatCompletionRequest, provider: Provider): Record<string, unknown> {
    const sanitized: Record<string, unknown> = { ...req };

    // 1. Strip 'options' (Ollama / Hermes custom param that causes 400 on NVIDIA NIM / strict proxies)
    delete sanitized.options;

    // 2. Normalize and strip empty tools if not populated
    if (Array.isArray(sanitized.tools) && sanitized.tools.length === 0) {
      delete sanitized.tools;
      delete sanitized.tool_choice;
    }

    // 3. Normalize reasoning parameters across providers
    const modelStr = String(sanitized.model || "").toLowerCase();
    const isReasoningModel =
      modelStr.includes("o1") ||
      modelStr.includes("o3") ||
      modelStr.includes("o4") ||
      modelStr.includes("deepseek-r1") ||
      modelStr.includes("thinking") ||
      modelStr.includes("reasoner");

    if (provider.type === "openai") {
      delete sanitized.top_k;

      if (isReasoningModel) {
        // Map Anthropic-style thinking budget to OpenAI reasoning_effort if present
        const thinkingObj = (sanitized as any).thinking;
        if (thinkingObj && typeof thinkingObj === "object" && thinkingObj.budget_tokens && !(sanitized as any).reasoning_effort) {
          const budget = thinkingObj.budget_tokens;
          if (budget < 3000) (sanitized as any).reasoning_effort = "low";
          else if (budget < 7000) (sanitized as any).reasoning_effort = "medium";
          else (sanitized as any).reasoning_effort = "high";
        }
        delete (sanitized as any).thinking;
        delete (sanitized as any).thinkingConfig;

        // Alias max_tokens to max_completion_tokens for OpenAI reasoning models
        if (sanitized.max_tokens !== undefined && (sanitized as any).max_completion_tokens === undefined) {
          (sanitized as any).max_completion_tokens = sanitized.max_tokens;
          delete sanitized.max_tokens;
        }
      } else {
        // Non-reasoning model: strip reasoning parameters to prevent upstream 400 rejection
        delete (sanitized as any).reasoning_effort;
        delete (sanitized as any).thinking;
        delete (sanitized as any).thinkingConfig;

        // Back-fill max_tokens if client only supplied max_completion_tokens
        if (sanitized.max_tokens === undefined && (sanitized as any).max_completion_tokens !== undefined) {
          sanitized.max_tokens = (sanitized as any).max_completion_tokens;
        }
      }
    }

    // 4. Remove undefined / null properties
    for (const key of Object.keys(sanitized)) {
      if (sanitized[key] === undefined || sanitized[key] === null) {
        delete sanitized[key];
      }
    }

    return sanitized;
  }
}
