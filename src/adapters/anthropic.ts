// Native Anthropic Messages Protocol Adapter (Multimodal Vision + Tool Calling)
import type { ChatCompletionRequest, ChatMessage, ToolCall, ToolDefinition } from "../types";

export interface AnthropicContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  source?: {
    type: "base64";
    media_type: string;
    data: string;
  };
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | unknown[];
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicPayload {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
  }>;
}

export class AnthropicAdapter {
  private static parseContentBlocks(content: unknown): AnthropicContentBlock[] {
    if (typeof content === "string") {
      return content.trim() ? [{ type: "text", text: content }] : [];
    }

    if (Array.isArray(content)) {
      const blocks: AnthropicContentBlock[] = [];
      for (const item of content) {
        if (typeof item === "string") {
          blocks.push({ type: "text", text: item });
        } else if (item && typeof item === "object") {
          const b = item as any;
          if (b.type === "text" && typeof b.text === "string") {
            blocks.push({ type: "text", text: b.text });
          } else if (b.type === "image_url" && typeof b.image_url?.url === "string") {
            const url = b.image_url.url;
            if (url.startsWith("data:")) {
              const matches = url.match(/^data:([a-zA-Z0-9/+-]+);base64,(.+)$/);
              if (matches) {
                blocks.push({
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: matches[1],
                    data: matches[2],
                  },
                });
              }
            }
          }
        }
      }
      return blocks;
    }

    return [{ type: "text", text: JSON.stringify(content) }];
  }

  /**
   * Convert OpenAI ChatCompletionRequest into Anthropic /v1/messages payload
   */
  static transformRequest(req: ChatCompletionRequest, targetModel: string): AnthropicPayload {
    const messages: AnthropicMessage[] = [];
    const systemParts: string[] = [];

    for (const msg of req.messages) {
      if (msg.role === "system") {
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        systemParts.push(text);
        continue;
      }

      if (msg.role === "tool") {
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: msg.tool_call_id || "call_unknown",
              content: text,
            },
          ],
        });
        continue;
      }

      const role = msg.role === "assistant" ? "assistant" : "user";
      const blocks: AnthropicContentBlock[] = this.parseContentBlocks(msg.content);

      // Assistant tool calls
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(tc.function.arguments);
          } catch {}
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: parsedInput,
          });
        }
      }

      // Merge consecutive messages with the same role
      const lastMsg = messages[messages.length - 1];
      if (lastMsg && lastMsg.role === role) {
        if (Array.isArray(lastMsg.content)) {
          lastMsg.content.push(...blocks);
        } else {
          lastMsg.content = [{ type: "text", text: lastMsg.content }, ...blocks];
        }
      } else if (blocks.length > 0) {
        messages.push({ role, content: blocks });
      }
    }

    if (messages.length === 0) {
      messages.push({ role: "user", content: "Hello" });
    }

    const payload: AnthropicPayload = {
      model: targetModel,
      messages,
      max_tokens: req.max_tokens ?? 4096, // Anthropic mandates max_tokens
      stream: req.stream,
    };

    if (systemParts.length > 0) {
      payload.system = systemParts.join("\n\n");
    }

    if (req.temperature !== undefined) payload.temperature = req.temperature;
    if (req.top_p !== undefined) payload.top_p = req.top_p;

    // Thinking & Reasoning Effort Support (Claude 3.7 Sonnet, etc.)
    const clientThinking = (req as any).thinking;
    const clientReasoning = (req as any).reasoning_effort;

    let thinkingBudget: number | undefined;
    if (clientThinking && typeof clientThinking === "object" && clientThinking.budget_tokens) {
      thinkingBudget = clientThinking.budget_tokens;
    } else if (clientReasoning) {
      if (clientReasoning === "low") thinkingBudget = 2048;
      else if (clientReasoning === "medium") thinkingBudget = 4096;
      else if (clientReasoning === "high") thinkingBudget = 8192;
    }

    if (thinkingBudget && thinkingBudget > 0) {
      payload.thinking = { type: "enabled", budget_tokens: thinkingBudget };
      payload.max_tokens = Math.max(payload.max_tokens, thinkingBudget + 2048);
      delete payload.temperature;
    }

    // Tools conversion
    if (Array.isArray(req.tools) && req.tools.length > 0) {
      payload.tools = req.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: (t.function.parameters as Record<string, unknown>) || { type: "object", properties: {} },
      }));
    }

    return payload;
  }

  /**
   * Transform Anthropic Non-Streaming Response to OpenAI ChatCompletion
   */
  static transformResponse(data: any, requestedModel: string): Record<string, unknown> {
    const rawBlocks = Array.isArray(data?.content) ? data.content : [];
    let textContent = "";
    const toolCalls: ToolCall[] = [];

    for (const b of rawBlocks) {
      if (b.type === "text" && typeof b.text === "string") {
        textContent += b.text;
      } else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id || "call_" + crypto.randomUUID().slice(0, 12),
          type: "function",
          function: {
            name: b.name || "unknown",
            arguments: JSON.stringify(b.input || {}),
          },
        });
      }
    }

    const isToolCall = toolCalls.length > 0;
    const stopReason = isToolCall
      ? "tool_calls"
      : data?.stop_reason === "end_turn"
      ? "stop"
      : (data?.stop_reason || "stop");

    const promptTokens = data?.usage?.input_tokens ?? 0;
    const completionTokens = data?.usage?.output_tokens ?? 0;

    const message: Record<string, unknown> = {
      role: "assistant",
      content: isToolCall && !textContent ? null : textContent,
    };

    if (isToolCall) {
      message.tool_calls = toolCalls;
    }

    return {
      id: "chatcmpl-" + (data?.id || crypto.randomUUID().slice(0, 12)),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [
        {
          index: 0,
          message,
          finish_reason: stopReason,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
  }

  /**
   * Web Stream Transformer: Anthropic SSE Events -> OpenAI Standard SSE Stream
   */
  static createStreamTransformer(
    anthropicStream: ReadableStream<Uint8Array>,
    requestedModel: string,
    onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let buffer = "";
    const completionId = "chatcmpl-" + crypto.randomUUID().slice(0, 12);
    const created = Math.floor(Date.now() / 1000);
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let currentToolId = "";
    let currentToolName = "";
    let currentToolIndex = 0;

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;

          const jsonStr = trimmed.slice(6);
          if (!jsonStr) continue;

          try {
            const data = JSON.parse(jsonStr);

            if (data.type === "message_start" && data.message?.usage) {
              totalPromptTokens = data.message.usage.input_tokens || 0;
            }

            // Start of a tool_use block
            if (data.type === "content_block_start" && data.content_block?.type === "tool_use") {
              currentToolId = data.content_block.id || "call_" + crypto.randomUUID().slice(0, 12);
              currentToolName = data.content_block.name || "";
              currentToolIndex = data.index ?? 0;

              const toolStartChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: requestedModel,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: currentToolIndex,
                          id: currentToolId,
                          type: "function",
                          function: {
                            name: currentToolName,
                            arguments: "",
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(toolStartChunk)}\n\n`));
            }

            // Text delta
            if (data.type === "content_block_delta" && data.delta?.type === "text_delta" && data.delta?.text) {
              const openAiChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: requestedModel,
                choices: [
                  {
                    index: 0,
                    delta: { content: data.delta.text },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAiChunk)}\n\n`));
            }

            // Tool input json delta
            if (data.type === "content_block_delta" && data.delta?.type === "input_json_delta" && data.delta?.partial_json) {
              const toolArgChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: requestedModel,
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: currentToolIndex,
                          function: {
                            arguments: data.delta.partial_json,
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(toolArgChunk)}\n\n`));
            }

            if (data.type === "message_delta") {
              if (data.usage?.output_tokens) {
                totalCompletionTokens = data.usage.output_tokens;
              }

              if (onUsage) {
                onUsage({
                  prompt_tokens: totalPromptTokens,
                  completion_tokens: totalCompletionTokens,
                  total_tokens: totalPromptTokens + totalCompletionTokens,
                });
              }

              const isTool = data.delta?.stop_reason === "tool_use";
              const stopReason = isTool ? "tool_calls" : (data.delta?.stop_reason === "end_turn" ? "stop" : data.delta?.stop_reason || "stop");
              const finishChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: requestedModel,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: stopReason,
                  },
                ],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
            }
          } catch {
            // Ignore partial lines
          }
        }
      },
      flush(controller) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      },
    });

    return anthropicStream.pipeThrough(transform);
  }
}
