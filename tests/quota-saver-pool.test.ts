import { describe, expect, it } from "bun:test";
import { KeyPoolManager } from "../src/core/pool";
import { QuotaSaverEngine } from "../src/core/quota-saver";
import type { Provider, ChatCompletionRequest } from "../src/types";

describe("Least-Connections Key Balancer & Quota Saver", () => {
  it("routes to the key with least in-flight connections", () => {
    KeyPoolManager.reset();
    const provider: Provider = {
      id: "p-least",
      name: "Least Conn Provider",
      baseUrl: "https://api.example.com",
      apiKey: "key_A, key_B, key_C",
      keyStrategy: "least-connections",
      type: "openai",
      enabled: true,
    };

    // Initially all have 0 in-flight; selects key_A
    const k1 = KeyPoolManager.selectKey(provider);
    expect(k1).toBe("key_A");

    // Acquire key_A for a long request
    const releaseA = KeyPoolManager.acquireKey("key_A");
    expect(KeyPoolManager.getInFlight("key_A")).toBe(1);

    // Next selection should skip key_A and pick key_B (which has 0 in-flight)
    const k2 = KeyPoolManager.selectKey(provider);
    expect(k2).toBe("key_B");

    const releaseB = KeyPoolManager.acquireKey("key_B");
    expect(KeyPoolManager.getInFlight("key_B")).toBe(1);

    // Next selection should pick key_C (0 in-flight)
    const k3 = KeyPoolManager.selectKey(provider);
    expect(k3).toBe("key_C");

    // Release key_A
    releaseA();
    expect(KeyPoolManager.getInFlight("key_A")).toBe(0);

    // Now key_A is idle again, next selection should pick key_A!
    const k4 = KeyPoolManager.selectKey(provider);
    expect(k4).toBe("key_A");

    releaseB();
  });

  it("QuotaSaver truncates oversized tool outputs (>4000 chars) while keeping head and tail", () => {
    const hugeOutput = "START_TOOL_HEADER " + "X".repeat(10000) + " END_TOOL_FOOTER";
    const req: ChatCompletionRequest = {
      model: "gemini-flash-latest",
      messages: [
        { role: "user", content: "run test" },
        { role: "assistant", content: "running" },
        { role: "tool", tool_call_id: "call_1", content: hugeOutput },
      ],
    };

    const { optimizedReq, tokensSaved } = QuotaSaverEngine.optimize(req);
    const toolMsg = optimizedReq.messages[2];
    expect(typeof toolMsg.content).toBe("string");
    expect((toolMsg.content as string).length).toBeLessThan(hugeOutput.length);
    expect(toolMsg.content as string).toContain("START_TOOL_HEADER");
    expect(toolMsg.content as string).toContain("END_TOOL_FOOTER");
    expect(toolMsg.content as string).toContain("[Truncated");
    expect(tokensSaved).toBeGreaterThan(1500); // Saved >1,500 tokens!
  });

  it("QuotaSaver strips historical images from older turns while keeping active turn images", () => {
    const req: ChatCompletionRequest = {
      model: "gemini-flash-latest",
      messages: [
        // Turn 1 (Historical): has image
        {
          role: "user",
          content: [
            { type: "text", text: "Look at this historical error" },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAA..." } },
          ],
        },
        { role: "assistant", content: "I see it" },
        { role: "user", content: "What about this?" },
        { role: "assistant", content: "Done" },
        // Turn 3 (Active turn): has image
        {
          role: "user",
          content: [
            { type: "text", text: "Look at new screenshot" },
            { type: "image_url", image_url: { url: "data:image/png;base64,NEW_IMAGE..." } },
          ],
        },
      ],
    };

    const { optimizedReq } = QuotaSaverEngine.optimize(req, {
      enabled: true,
      maxToolOutputChars: 4000,
      preserveLastTurns: 2, // Last 2 turns preserved completely
      stripHistoricalImages: true,
      autoRecoverOn413: true,
    });

    const historicalUserMsg = optimizedReq.messages[0].content as any[];
    const activeUserMsg = optimizedReq.messages[4].content as any[];

    // Historical image replaced by token-saver placeholder text
    expect(historicalUserMsg[1].type).toBe("text");
    expect(historicalUserMsg[1].text).toContain("Historical image omitted by Quota Saver");

    // Active image preserved intact!
    expect(activeUserMsg[1].type).toBe("image_url");
    expect(activeUserMsg[1].image_url.url).toContain("NEW_IMAGE");
  });

  it("QuotaSaver aggressiveCompress performs middle-out compaction on 413 context overflow", () => {
    const req: ChatCompletionRequest = {
      model: "gemini-flash-latest",
      messages: [
        { role: "system", content: "You are an assistant." },
        { role: "user", content: "Initial Task: Build app." },
        { role: "assistant", content: "Step 1" },
        { role: "user", content: "Step 2" },
        { role: "assistant", content: "Step 3" },
        { role: "user", content: "Step 4" },
        { role: "assistant", content: "Latest step" },
      ],
    };

    const compressed = QuotaSaverEngine.aggressiveCompress(req);

    // Should keep system prompt + initial user prompt + middle compaction + last 3 turns
    expect(compressed.messages.length).toBe(6);
    expect(compressed.messages[0].role).toBe("system");
    expect(compressed.messages[1].content).toBe("Initial Task: Build app.");
    expect(compressed.messages[2].content).toContain("Context Compaction");
    expect(compressed.messages[compressed.messages.length - 1].content).toBe("Latest step");
  });
});
