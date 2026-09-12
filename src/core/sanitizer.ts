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

    // 3. Remove undefined / null properties
    for (const key of Object.keys(sanitized)) {
      if (sanitized[key] === undefined || sanitized[key] === null) {
        delete sanitized[key];
      }
    }

    // 4. Provider-specific stripping
    if (provider.type === "openai") {
      // If provider has custom headers or is standard OpenAI, ensure only official fields pass
      delete sanitized.top_k; // OpenAI doesn't support top_k
    }

    return sanitized;
  }
}
