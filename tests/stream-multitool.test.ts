import { describe, expect, it } from "bun:test";
import { AnthropicAdapter } from "../src/adapters/anthropic";
import { createKeepAliveStream } from "../src/core/stream";

describe("Anthropic Multi-Tool Merge & SSE Keep-Alive", () => {
  it("merges consecutive tool results into a single user message", () => {
    const payload = AnthropicAdapter.transformRequest(
      {
        model: "claude-3-7-sonnet",
        messages: [
          { role: "user", content: "read files" },
          {
            role: "assistant",
            content: "running tools",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "readFile", arguments: '{"path":"a.txt"}' } },
              { id: "call_2", type: "function", function: { name: "readFile", arguments: '{"path":"b.txt"}' } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "content A" },
          { role: "tool", tool_call_id: "call_2", content: "content B" },
        ],
      },
      "claude-3-7-sonnet-20250219"
    );

    // Messages should alternate: user -> assistant -> user (ONE user message containing both tool results!)
    expect(payload.messages.length).toBe(3);
    expect(payload.messages[0].role).toBe("user");
    expect(payload.messages[1].role).toBe("assistant");
    expect(payload.messages[2].role).toBe("user");

    const toolResultBlocks = payload.messages[2].content as any[];
    expect(toolResultBlocks.length).toBe(2);
    expect(toolResultBlocks[0].type).toBe("tool_result");
    expect(toolResultBlocks[0].tool_use_id).toBe("call_1");
    expect(toolResultBlocks[1].type).toBe("tool_result");
    expect(toolResultBlocks[1].tool_use_id).toBe("call_2");
  });

  it("sanitizes orphan tool results without matching tool_call into safe text blocks", () => {
    const payload = AnthropicAdapter.transformRequest(
      {
        model: "claude-3-7-sonnet",
        messages: [
          { role: "user", content: "test" },
          {
            role: "assistant",
            content: "ok",
            tool_calls: [
              { id: "call_valid", type: "function", function: { name: "test", arguments: "{}" } },
            ],
          },
          // Orphan tool call ID not in assistant.tool_calls
          { role: "tool", tool_call_id: "call_non_existent", content: "orphan data" },
        ],
      },
      "claude-3-7-sonnet-20250219"
    );

    expect(payload.messages.length).toBe(3);
    const lastContent = payload.messages[2].content as any[];
    // Orphan is converted to text to prevent Anthropic 400 rejection
    expect(lastContent[0].type).toBe("text");
    expect(lastContent[0].text).toContain("[Tool Result call_non_existent]: orphan data");
  });

  it("ensures conversation always starts with role 'user' for Anthropic compliance", () => {
    const payload = AnthropicAdapter.transformRequest(
      {
        model: "claude-3-7-sonnet",
        messages: [
          { role: "assistant", content: "I am an assistant starting first" },
          { role: "user", content: "hello" },
        ],
      },
      "claude-3-7-sonnet-20250219"
    );

    expect(payload.messages[0].role).toBe("user");
  });

  it("createKeepAliveStream emits W3C ping comments when stream is idle", async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Create a slow stream that emits 1 chunk after 40ms
    const slowStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((r) => setTimeout(r, 60));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
        controller.close();
      },
    });

    // Set pingIntervalMs to 20ms so it fires at least once before chunk arrives
    const keepAlive = createKeepAliveStream(slowStream, {
      pingIntervalMs: 20,
    });

    const reader = keepAlive.getReader();
    let received = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
    }

    expect(received).toContain(": ping\n\n");
    expect(received).toContain('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n');
  });
});
