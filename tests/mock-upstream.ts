// Local mock upstream used to verify token accounting end-to-end.
// Not part of the gateway runtime — test harness only.
const PORT = Number(process.env.MOCK_PORT || 20999);

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/v1/models") {
      return Response.json({
        object: "list",
        data: [{ id: "mock-model", object: "model", owned_by: "mock" }],
      });
    }

    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const body = (await req.json()) as { stream?: boolean };

      if (body.stream) {
        const encoder = new TextEncoder();
        const chunks = [
          `data: ${JSON.stringify({ id: "mock-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ id: "mock-1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 24, completion_tokens: 6, total_tokens: 30 } })}\n\n`,
          "data: [DONE]\n\n",
        ];
        const stream = new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(encoder.encode(c));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
      }

      return Response.json({
        id: "mock-1",
        object: "chat.completion",
        model: "mock-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 24, completion_tokens: 6, total_tokens: 30 },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`mock upstream listening on ${PORT}`);
