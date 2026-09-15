// Native Google Gemini Protocol Adapter (Multimodal Vision + Tool Calling)
import type { ChatCompletionRequest, ChatMessage, ToolCall, ToolDefinition } from "../types";

export interface GeminiPart {
  text?: string;
  thoughtSignature?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
  };
  functionResponse?: {
    name: string;
    response: Record<string, unknown>;
  };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiPayload {
  contents: GeminiContent[];
  systemInstruction?: {
    parts: GeminiPart[];
  };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
  };
  tools?: Array<{
    functionDeclarations: Array<{
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
    }>;
  }>;
  toolConfig?: unknown;
}

export class GeminiAdapter {
  /**
   * Parse OpenAI Message Content into Gemini Parts (supporting Text & Vision data URLs)
   */
  private static parseParts(content: unknown): GeminiPart[] {
    if (typeof content === "string") {
      return content.trim() ? [{ text: content }] : [];
    }

    if (Array.isArray(content)) {
      const parts: GeminiPart[] = [];
      for (const block of content) {
        if (typeof block === "string") {
          parts.push({ text: block });
        } else if (block && typeof block === "object") {
          const b = block as any;
          if (b.type === "text" && typeof b.text === "string") {
            parts.push({ text: b.text });
          } else if (b.type === "image_url" && typeof b.image_url?.url === "string") {
            const url = b.image_url.url;
            if (url.startsWith("data:")) {
              const matches = url.match(/^data:([a-zA-Z0-9/+-]+);base64,(.+)$/);
              if (matches) {
                parts.push({
                  inlineData: {
                    mimeType: matches[1],
                    data: matches[2],
                  },
                });
              }
            }
          }
        }
      }
      return parts;
    }

    return [{ text: JSON.stringify(content) }];
  }

  /**
   * Convert OpenAI ChatCompletionRequest into Gemini Native Payload
   */
  static transformRequest(req: ChatCompletionRequest): GeminiPayload {
    const contents: GeminiContent[] = [];
    const systemParts: GeminiPart[] = [];

    // Map tool_call_id to function name across assistant messages so tool responses without explicit name resolve properly
    const toolCallNameMap = new Map<string, string>();
    for (const msg of req.messages) {
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc.id && tc.function?.name) {
            toolCallNameMap.set(tc.id, tc.function.name);
          }
        }
      }
    }

    for (const msg of req.messages) {
      if (msg.role === "system") {
        systemParts.push(...this.parseParts(msg.content));
        continue;
      }

      // Tool Call response from previous turn
      if (msg.role === "tool") {
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        let parsedResponse: Record<string, unknown>;
        try {
          parsedResponse = JSON.parse(text);
          if (typeof parsedResponse !== "object" || parsedResponse === null) {
            parsedResponse = { result: parsedResponse };
          }
        } catch {
          parsedResponse = { output: text };
        }

        const functionName = msg.name || (msg.tool_call_id ? toolCallNameMap.get(msg.tool_call_id) : undefined) || "tool_result";

        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: functionName,
                response: parsedResponse,
              },
            },
          ],
        });
        continue;
      }

      const role = msg.role === "assistant" ? "model" : "user";
      const parts = this.parseParts(msg.content);

      // Assistant tool calls
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          let parsedArgs = {};
          try {
            parsedArgs = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : (tc.function.arguments || {});
          } catch {}
          const thoughtSig = (tc as any).extra_content?.google?.thought_signature || (tc as any).thoughtSignature || "skip_thought_signature_validator";
          parts.push({
            functionCall: {
              name: tc.function.name,
              args: parsedArgs,
            },
            thoughtSignature: thoughtSig,
          });
        }
      }

      // Merge consecutive messages with the same role
      const lastContent = contents[contents.length - 1];
      if (lastContent && lastContent.role === role) {
        lastContent.parts.push(...parts);
      } else if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }

    if (contents.length === 0) {
      contents.push({ role: "user", parts: [{ text: "Hello" }] });
    }

    const payload: GeminiPayload = { contents };

    if (systemParts.length > 0) {
      payload.systemInstruction = { parts: systemParts };
    }

    // Config
    if (req.temperature !== undefined || req.top_p !== undefined || req.max_tokens !== undefined) {
      payload.generationConfig = {
        temperature: req.temperature,
        topP: req.top_p,
        maxOutputTokens: req.max_tokens,
      };
    }

    // Thinking Config Support (Gemini 2.5 / 3 Flash & Pro)
    const clientThinking = (req as any).thinking;
    const clientReasoning = (req as any).reasoning_effort;

    let geminiThinkingBudget: number | undefined;
    if (clientThinking && typeof clientThinking === "object" && clientThinking.budget_tokens !== undefined) {
      geminiThinkingBudget = clientThinking.budget_tokens;
    } else if (clientReasoning) {
      if (clientReasoning === "low") geminiThinkingBudget = 2048;
      else if (clientReasoning === "medium") geminiThinkingBudget = 4096;
      else if (clientReasoning === "high") geminiThinkingBudget = 8192;
      else if (clientReasoning === "none") geminiThinkingBudget = 0;
    }

    if (geminiThinkingBudget !== undefined) {
      if (!payload.generationConfig) payload.generationConfig = {};
      (payload.generationConfig as any).thinkingConfig = {
        thinkingBudget: geminiThinkingBudget,
      };
    }

    // Function Calling / Tools
    if (Array.isArray(req.tools) && req.tools.length > 0) {
      payload.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          })),
        },
      ];
    }

    return payload;
  }

  /**
   * Transform Gemini Non-Streaming Response to OpenAI ChatCompletion
   */
  static transformResponse(geminiData: any, requestedModel: string): Record<string, unknown> {
    const candidate = geminiData?.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    let textPart = "";
    const toolCalls: ToolCall[] = [];

    for (const part of parts) {
      if (part.text) {
        textPart += part.text;
      }
      if (part.functionCall) {
        const thoughtSig = part.thoughtSignature || (part as any).thought_signature;
        const tc: any = {
          id: (part.functionCall as any).id || ("call_" + crypto.randomUUID().slice(0, 12)),
          type: "function",
          function: {
            name: part.functionCall.name,
            arguments: JSON.stringify(part.functionCall.args || {}),
          },
        };
        if (thoughtSig) {
          tc.extra_content = { google: { thought_signature: thoughtSig } };
        }
        toolCalls.push(tc);
      }
    }

    const isToolCall = toolCalls.length > 0;
    const finishReason = isToolCall
      ? "tool_calls"
      : candidate?.finishReason === "STOP"
      ? "stop"
      : (candidate?.finishReason?.toLowerCase() || "stop");

    const promptTokens = geminiData?.usageMetadata?.promptTokenCount ?? 0;
    const completionTokens = geminiData?.usageMetadata?.candidatesTokenCount ?? 0;
    const totalTokens = geminiData?.usageMetadata?.totalTokenCount ?? (promptTokens + completionTokens);

    const message: Record<string, unknown> = {
      role: "assistant",
      content: isToolCall && !textPart ? null : textPart,
    };

    if (isToolCall) {
      message.tool_calls = toolCalls;
    }

    return {
      id: "chatcmpl-" + crypto.randomUUID().slice(0, 12),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: requestedModel,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
      },
    };
  }

  /**
   * Web Stream Transformer: Gemini SSE Stream -> OpenAI Standard SSE Stream
   */
  static createStreamTransformer(
    geminiStream: ReadableStream<Uint8Array>,
    requestedModel: string,
    onUsage?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let buffer = "";
    const completionId = "chatcmpl-" + crypto.randomUUID().slice(0, 12);
    const created = Math.floor(Date.now() / 1000);

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;

          const jsonStr = trimmed.slice(6);
          if (!jsonStr || jsonStr === "[DONE]") continue;

          try {
            const data = JSON.parse(jsonStr);
            const candidate = data?.candidates?.[0];
            const parts = candidate?.content?.parts || [];

            for (const part of parts) {
              if (part.text) {
                const openAiChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: requestedModel,
                  choices: [
                    {
                      index: 0,
                      delta: { content: part.text },
                      finish_reason: null,
                    },
                  ],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(openAiChunk)}\n\n`));
              }

              if (part.functionCall) {
                const thoughtSig = part.thoughtSignature || (part as any).thought_signature;
                const toolCallObj: any = {
                  index: 0,
                  id: (part.functionCall as any).id || ("call_" + crypto.randomUUID().slice(0, 12)),
                  type: "function",
                  function: {
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args || {}),
                  },
                };
                if (thoughtSig) {
                  toolCallObj.extra_content = { google: { thought_signature: thoughtSig } };
                }
                const toolChunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: requestedModel,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [toolCallObj],
                      },
                      finish_reason: null,
                    },
                  ],
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(toolChunk)}\n\n`));
              }
            }

            if (data?.usageMetadata && onUsage) {
              const prompt_tokens = data.usageMetadata.promptTokenCount ?? 0;
              const completion_tokens = data.usageMetadata.candidatesTokenCount ?? 0;
              onUsage({
                prompt_tokens,
                completion_tokens,
                total_tokens: prompt_tokens + completion_tokens,
              });
            }

            if (candidate?.finishReason) {
              const finishChunk = {
                id: completionId,
                object: "chat.completion.chunk",
                created,
                model: requestedModel,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: candidate.finishReason === "STOP" ? "stop" : candidate.finishReason.toLowerCase(),
                  },
                ],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
            }
          } catch {
            // Ignore incomplete segments
          }
        }
      },
      flush(controller) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      },
    });

    return geminiStream.pipeThrough(transform);
  }
}
