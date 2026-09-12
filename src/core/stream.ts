// Web Streams API native SSE stream transformer with keep-alive ping & usage sniffer

export function createKeepAliveStream(
  upstreamStream: ReadableStream<Uint8Array>,
  options: {
    pingIntervalMs?: number;
    onUsage?: (usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) => void;
  } = {}
): ReadableStream<Uint8Array> {
  const pingInterval = options.pingIntervalMs ?? 15000;
  let timer: ReturnType<typeof setInterval> | null = null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          if (timer) clearInterval(timer);
        }
      }, pingInterval);
    },
    transform(chunk, controller) {
      controller.enqueue(chunk);

      if (options.onUsage) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
            try {
              const jsonStr = trimmed.slice(6);
              const parsed = JSON.parse(jsonStr);
              if (parsed?.usage) {
                options.onUsage(parsed.usage);
              }
            } catch {
              // Ignore partial JSON chunks
            }
          }
        }
      }
    },
    flush() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  });

  return upstreamStream.pipeThrough(transform);
}
