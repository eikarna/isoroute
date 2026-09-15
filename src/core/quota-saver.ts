// IsoRoute Quota Saver: Intelligent Context Compression & Token Reducer
// Protects agent loops from context overflow and reduces token consumption by up to 60%
import type { ChatCompletionRequest } from "../types";

export interface QuotaSaverConfig {
  enabled: boolean;
  maxToolOutputChars: number; // default 4000
  preserveLastTurns: number; // default 4
  stripHistoricalImages: boolean; // default true
  autoRecoverOn413: boolean; // default true
}

export interface QuotaSaverStats {
  tokensSavedTotal: number;
  requestsOptimized: number;
  lastOptimizedAt?: number;
}

export const DEFAULT_QUOTA_SAVER_CONFIG: QuotaSaverConfig = {
  enabled: true,
  maxToolOutputChars: 4000,
  preserveLastTurns: 4,
  stripHistoricalImages: true,
  autoRecoverOn413: true,
};

export let activeQuotaSaverConfig: QuotaSaverConfig = { ...DEFAULT_QUOTA_SAVER_CONFIG };

export function updateQuotaSaverConfig(patch: Partial<QuotaSaverConfig>): QuotaSaverConfig {
  activeQuotaSaverConfig = { ...activeQuotaSaverConfig, ...patch };
  return activeQuotaSaverConfig;
}

export class QuotaSaverEngine {
  /**
   * Optimize conversation payload by compressing long tool outputs and historical multimodal content
   */
  static optimize(
    req: ChatCompletionRequest,
    config: QuotaSaverConfig = DEFAULT_QUOTA_SAVER_CONFIG
  ): { optimizedReq: ChatCompletionRequest; tokensSaved: number } {
    if (!config.enabled || !Array.isArray(req.messages) || req.messages.length === 0) {
      return { optimizedReq: req, tokensSaved: 0 };
    }

    const jsonBefore = JSON.stringify(req.messages);
    const charsBefore = jsonBefore.length;

    const messages = req.messages.map((m) => ({ ...m }));
    const totalMessages = messages.length;

    // 1. Tool Output Truncation & Historical Message Compaction
    for (let i = 0; i < totalMessages; i++) {
      const msg = messages[i];
      const isHistorical = i < totalMessages - config.preserveLastTurns;

      // Truncate long tool outputs
      if (msg.role === "tool" && typeof msg.content === "string") {
        if (msg.content.length > config.maxToolOutputChars) {
          const keepHead = Math.floor(config.maxToolOutputChars * 0.4);
          const keepTail = Math.floor(config.maxToolOutputChars * 0.4);
          const head = msg.content.slice(0, keepHead);
          const tail = msg.content.slice(-keepTail);
          const omitted = msg.content.length - (keepHead + keepTail);
          msg.content = `${head}\n\n... [Truncated ${omitted} chars by IsoRoute Quota Saver] ...\n\n${tail}`;
        } else if (isHistorical && msg.content.length > 800) {
          // In older historical turns, compact moderate tool results
          const head = msg.content.slice(0, 300);
          const tail = msg.content.slice(-200);
          const omitted = msg.content.length - 500;
          msg.content = `${head}\n... [Historical tool output compacted: ${omitted} chars omitted] ...\n${tail}`;
        }
      }

      // Strip historical images to prevent sending megabytes of image tokens on every turn
      if (config.stripHistoricalImages && isHistorical && Array.isArray(msg.content)) {
        msg.content = (msg.content as any[]).map((block) => {
          if (block.type === "image_url") {
            return {
              type: "text",
              text: "[Historical image omitted by Quota Saver to save token bandwidth]",
            };
          }
          return block;
        });
      }
    }

    const jsonAfter = JSON.stringify(messages);
    const charsAfter = jsonAfter.length;
    // Standard rule of thumb: ~4 characters per token
    const tokensSaved = Math.max(0, Math.round((charsBefore - charsAfter) / 4));

    return {
      optimizedReq: { ...req, messages },
      tokensSaved,
    };
  }

  /**
   * Emergency middle-out compression invoked when upstream rejects with 413 / context_length_exceeded
   */
  static aggressiveCompress(req: ChatCompletionRequest): ChatCompletionRequest {
    if (!Array.isArray(req.messages) || req.messages.length <= 4) {
      return req;
    }

    const messages = [...req.messages];
    const systemMessages = messages.filter((m) => m.role === "system");
    const nonSystem = messages.filter((m) => m.role !== "system");

    // Preserve initial user prompt (Zone 1) + last 3 turns (Zone 3)
    const initialTurn = nonSystem[0];
    const recentTurns = nonSystem.slice(-3);

    // Intermediate turns (Zone 2) are compacted into a single summary reminder
    const intermediate = nonSystem.slice(1, -3);
    const compactedMiddle = {
      role: "user" as const,
      content: `[Context Compaction: ${intermediate.length} intermediate turns were compressed by IsoRoute to fit within model context window.]`,
    };

    return {
      ...req,
      messages: [...systemMessages, initialTurn, compactedMiddle, ...recentTurns],
    };
  }
}
