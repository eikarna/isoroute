import { describe, expect, it } from "bun:test";
import { GeminiAdapter } from "../src/adapters/gemini";
import { AnthropicAdapter } from "../src/adapters/anthropic";
import { KeyPoolManager } from "../src/core/pool";
import { RequestSanitizer } from "../src/core/sanitizer";
import type { ChatCompletionRequest, Provider } from "../src/types";

describe("GeminiAdapter", () => {
  it("transforms OpenAI messages to Gemini contents and systemInstruction", () => {
    const req: ChatCompletionRequest = {
      model: "gemini-1.5-flash",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
        { role: "user", content: "Tell me a joke." },
      ],
      temperature: 0.7,
      max_tokens: 100,
    };

    const payload = GeminiAdapter.transformRequest(req);

    expect(payload.systemInstruction?.parts[0].text).toBe("You are a helpful assistant.");
    expect(payload.contents.length).toBe(3);
    expect(payload.contents[0].role).toBe("user");
    expect(payload.contents[0].parts[0].text).toBe("Hello");
    expect(payload.contents[1].role).toBe("model");
    expect(payload.contents[1].parts[0].text).toBe("Hi there!");
    expect(payload.contents[2].role).toBe("user");
    expect(payload.contents[2].parts[0].text).toBe("Tell me a joke.");
    expect(payload.generationConfig?.temperature).toBe(0.7);
    expect(payload.generationConfig?.maxOutputTokens).toBe(100);
  });

  it("handles multimodal image_url and converts to inlineData", () => {
    const req: ChatCompletionRequest = {
      model: "gemini-1.5-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==" } },
          ],
        },
      ],
    };

    const payload = GeminiAdapter.transformRequest(req);
    expect(payload.contents[0].parts.length).toBe(2);
    expect(payload.contents[0].parts[0].text).toBe("What is in this image?");
    expect(payload.contents[0].parts[1].inlineData?.mimeType).toBe("image/png");
    expect(payload.contents[0].parts[1].inlineData?.data).toBe("iVBORw0KGgoAAAANSUhEUg==");
  });

  it("translates OpenAI tools to Gemini functionDeclarations", () => {
    const req: ChatCompletionRequest = {
      model: "gemini-1.5-flash",
      messages: [{ role: "user", content: "Run terminal" }],
      tools: [
        {
          type: "function",
          function: {
            name: "terminal",
            description: "Execute shell command",
            parameters: { type: "object", properties: { command: { type: "string" } } },
          },
        },
      ],
    };

    const payload = GeminiAdapter.transformRequest(req);
    expect(payload.tools?.[0].functionDeclarations.length).toBe(1);
    expect(payload.tools?.[0].functionDeclarations[0].name).toBe("terminal");
    expect(payload.tools?.[0].functionDeclarations[0].description).toBe("Execute shell command");
  });

  it("transforms Gemini response with functionCall to OpenAI tool_calls", () => {
    const geminiRaw = {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "terminal",
                  args: { command: "ls -la" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 },
    };

    const res = GeminiAdapter.transformResponse(geminiRaw, "gemini-flash");
    expect((res.choices as any)[0].finish_reason).toBe("tool_calls");
    expect((res.choices as any)[0].message.tool_calls.length).toBe(1);
    expect((res.choices as any)[0].message.tool_calls[0].function.name).toBe("terminal");
    expect((res.choices as any)[0].message.tool_calls[0].function.arguments).toBe(JSON.stringify({ command: "ls -la" }));
  });
});

describe("AnthropicAdapter", () => {
  it("transforms OpenAI messages and vision blocks to Anthropic payload", () => {
    const req: ChatCompletionRequest = {
      model: "claude-3-5-sonnet",
      messages: [
        { role: "system", content: "System prompt instructions" },
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this chart" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,/9j/4AAQSkZJRg==" } },
          ],
        },
      ],
      temperature: 0.5,
    };

    const payload = AnthropicAdapter.transformRequest(req, "claude-3-5-sonnet-20241022");
    expect(payload.model).toBe("claude-3-5-sonnet-20241022");
    expect(payload.system).toBe("System prompt instructions");
    expect(payload.messages.length).toBe(1);
    expect(payload.messages[0].role).toBe("user");

    const contentBlocks = payload.messages[0].content as any[];
    expect(contentBlocks.length).toBe(2);
    expect(contentBlocks[0].type).toBe("text");
    expect(contentBlocks[1].type).toBe("image");
    expect(contentBlocks[1].source.media_type).toBe("image/jpeg");
    expect(contentBlocks[1].source.data).toBe("/9j/4AAQSkZJRg==");
  });

  it("translates OpenAI tools to Anthropic tools", () => {
    const req: ChatCompletionRequest = {
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "Inspect" }],
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            description: "Read file content",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          },
        },
      ],
    };

    const payload = AnthropicAdapter.transformRequest(req, "claude-3-5-sonnet");
    expect(payload.tools?.length).toBe(1);
    expect(payload.tools?.[0].name).toBe("read_file");
    expect(payload.tools?.[0].input_schema).toEqual({ type: "object", properties: { path: { type: "string" } } });
  });

  it("transforms Anthropic response with tool_use to OpenAI tool_calls", () => {
    const anthropicRaw = {
      id: "msg_999",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_01A",
          name: "read_file",
          input: { path: "src/index.ts" },
        },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 30, output_tokens: 15 },
    };

    const res = AnthropicAdapter.transformResponse(anthropicRaw, "claude-3-5-sonnet");
    expect((res.choices as any)[0].finish_reason).toBe("tool_calls");
    expect((res.choices as any)[0].message.tool_calls.length).toBe(1);
    expect((res.choices as any)[0].message.tool_calls[0].id).toBe("toolu_01A");
    expect((res.choices as any)[0].message.tool_calls[0].function.name).toBe("read_file");
  });
});

describe("RequestSanitizer", () => {
  it("strips 'options' parameter that causes HTTP 400 on NVIDIA NIM", () => {
    const req: ChatCompletionRequest = {
      model: "meta/llama-3.3-70b-instruct",
      messages: [{ role: "user", content: "hi" }],
      options: { num_ctx: 32768, temperature: 0.7 },
      tools: [], // empty tools should be removed
    };

    const provider: Provider = {
      id: "nvidia-nim",
      name: "NVIDIA NIM",
      baseUrl: "https://integrate.api.nvidia.com",
      type: "openai",
      enabled: true,
    };

    const sanitized = RequestSanitizer.sanitize(req, provider);
    expect(sanitized.options).toBeUndefined();
    expect(sanitized.tools).toBeUndefined();
    expect(sanitized.model).toBe("meta/llama-3.3-70b-instruct");
  });
});
