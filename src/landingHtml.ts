// Responsive, Robust Developer Gateway (Zero Horizontal Overflow, Table Fixed Layout)
export const PUBLIC_LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>IsoRoute — Isomorphic AI Gateway</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #09090b;
      --panel: #111114;
      --card: #18181b;
      --border: rgba(255, 255, 255, 0.08);
      --border-subtle: rgba(255, 255, 255, 0.04);
      --text: #ededed;
      --text-muted: #8e8e93;
      --text-dim: #636366;
      --accent: #e56a4a;
      --font-mono: 'JetBrains Mono', monospace;
      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    }

    *, *:before, *:after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
      overflow-x: hidden;
      width: 100%;
    }

    .wrap {
      max-width: 820px;
      margin: 0 auto;
      padding: 20px 14px 60px;
      display: flex;
      flex-direction: column;
      gap: 20px;
      width: 100%;
      box-sizing: border-box;
    }

    /* Top Nav */
    .nav {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 12px;
      width: 100%;
    }
    .nav-brand {
      font-family: var(--font-mono);
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .btn-admin {
      background: var(--card);
      border: 1px solid var(--border);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 500;
      padding: 4px 10px;
      border-radius: 4px;
      text-decoration: none;
      flex-shrink: 0;
    }
    .btn-admin:active { transform: translateY(1px); }

    /* Header Info */
    .header-block {
      display: flex;
      flex-direction: column;
      gap: 6px;
      width: 100%;
    }
    .header-block h1 {
      font-size: 18px;
      font-weight: 600;
      letter-spacing: -0.02em;
      color: var(--text);
    }
    .header-block p {
      font-size: 12.5px;
      color: var(--text-muted);
      line-height: 1.5;
      word-break: break-word;
    }

    /* Telemetry Grid */
    .telemetry-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      border: 1px solid var(--border);
      background: var(--border);
      gap: 1px;
      border-radius: 5px;
      overflow: hidden;
      width: 100%;
    }
    .tele-cell {
      background: var(--panel);
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .tele-label {
      font-family: var(--font-mono);
      font-size: 9px;
      color: var(--text-dim);
      letter-spacing: 0.04em;
    }
    .tele-val {
      font-family: var(--font-mono);
      font-size: 15px;
      font-weight: 600;
      color: var(--text);
      font-variant-numeric: tabular-nums;
    }

    /* Technical Box */
    .section-box {
      border: 1px solid var(--border);
      border-radius: 5px;
      background: var(--panel);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02);
      display: flex;
      flex-direction: column;
      width: 100%;
      overflow: hidden;
    }
    .box-header {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-dim);
    }
    .box-content {
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      width: 100%;
    }

    /* Endpoint Row */
    .endpoint-row {
      display: flex;
      background: #09090b;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 8px 10px;
      justify-content: space-between;
      align-items: center;
      font-family: var(--font-mono);
      font-size: 11px;
      width: 100%;
      gap: 8px;
    }
    .endpoint-row code {
      color: var(--text);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }
    .btn-copy {
      background: var(--card);
      border: 1px solid var(--border);
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 10px;
      padding: 3px 8px;
      border-radius: 3px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .btn-copy:active { transform: translateY(1px); }

    /* Code Snippet Tabs */
    .snippet-tabs {
      display: flex;
      gap: 4px;
    }
    .snippet-tab-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-dim);
      font-family: var(--font-mono);
      font-size: 10px;
      padding: 2px 8px;
      border-radius: 3px;
      cursor: pointer;
    }
    .snippet-tab-btn.active {
      background: var(--card);
      border-color: var(--border);
      color: var(--text);
    }
    .snippet-body {
      background: #09090b;
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 10px;
      font-family: var(--font-mono);
      font-size: 10.5px;
      color: #d4d4d8;
      overflow-x: auto;
      line-height: 1.45;
      width: 100%;
      white-space: pre;
    }

    /* Routes List: Stacked on Mobile, Table on Desktop */
    .routes-list {
      display: flex;
      flex-direction: column;
      width: 100%;
    }
    .route-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding: 9px 12px;
      border-bottom: 1px solid var(--border-subtle);
      font-family: var(--font-mono);
      font-size: 11px;
      gap: 10px;
      flex-wrap: wrap;
    }
    .route-row:last-child { border-bottom: none; }
    .r-slug { color: var(--accent); font-weight: 500; min-width: 80px; }
    .r-chain { color: var(--text-dim); font-size: 10.5px; flex: 1; word-break: break-all; }
    .r-badge { color: #22c55e; font-size: 9.5px; }

    footer {
      border-top: 1px solid var(--border-subtle);
      padding-top: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-dim);
      flex-wrap: wrap;
      gap: 8px;
      width: 100%;
    }
    footer a { color: var(--text-muted); text-decoration: none; }
    footer a:hover { color: var(--accent); }

    @media (max-width: 600px) {
      .wrap { padding: 14px 12px 40px; gap: 16px; }
      .telemetry-grid { grid-template-columns: 1fr 1fr; }
      .route-row { flex-direction: column; gap: 4px; }
    }
  </style>
</head>
<body>

<div class="wrap">
  <!-- Nav -->
  <header class="nav">
    <div class="nav-brand">
      <span>edgerouter</span>
      <span style="color:var(--text-dim)">/</span>
      <span style="color:var(--text-dim)">core</span>
    </div>
    <a href="/admin/dashboard" class="btn-admin">Admin ➔</a>
  </header>

  <!-- Lead -->
  <div class="header-block">
    <h1>Isomorphic AI Gateway</h1>
    <p>Zero-daemon reverse proxy and protocol translator for OpenAI, Google Gemini, and Anthropic Claude APIs with cascading priority failover.</p>
  </div>

  <!-- Telemetry Bar -->
  <div class="telemetry-grid">
    <div class="tele-cell">
      <span class="tele-label">REQUESTS</span>
      <span class="tele-val" id="t-req">—</span>
    </div>
    <div class="tele-cell">
      <span class="tele-label">TOKENS</span>
      <span class="tele-val" id="t-tok">—</span>
    </div>
    <div class="tele-cell">
      <span class="tele-label">COMBOS</span>
      <span class="tele-val" id="t-com">—</span>
    </div>
    <div class="tele-cell">
      <span class="tele-label">ENGINE</span>
      <span class="tele-val">WINTERCG</span>
    </div>
  </div>

  <!-- Quickstart Box -->
  <div class="section-box">
    <div class="box-header">
      <span>CLIENT INTEGRATION</span>
      <span>BASE URL</span>
    </div>
    <div class="box-content">
      <div class="endpoint-row">
        <code id="base-url-code">http://localhost:20129/v1</code>
        <button class="btn-copy" onclick="copyBaseUrl()">Copy</button>
      </div>

      <div class="snippet-tabs">
        <button class="snippet-tab-btn active" onclick="setLang('curl', this)">cURL</button>
        <button class="snippet-tab-btn" onclick="setLang('python', this)">Python</button>
        <button class="snippet-tab-btn" onclick="setLang('ts', this)">TypeScript</button>
      </div>

      <pre class="snippet-body" id="code-snippet">curl http://localhost:20129/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "free-fast",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'</pre>
    </div>
  </div>

  <!-- Active Combos List -->
  <div class="section-box">
    <div class="box-header">
      <span>CONFIGURED VIRTUAL ROUTES</span>
      <span id="routes-count">—</span>
    </div>
    <div class="routes-list" id="routes-container">
      <div style="color:var(--text-dim);text-align:center;padding:12px;font-family:var(--font-mono);font-size:11px">Loading routes...</div>
    </div>
  </div>

  <footer>
    <div>edgerouter v0.2.0 • 20129</div>
    <div><a href="/admin/dashboard">/admin/dashboard</a> [pass: 123456]</div>
  </footer>
</div>

<script>
  const host = window.location.origin;
  document.getElementById("base-url-code").textContent = host + "/v1";

  const snippets = {
    curl: \`curl \${host}/v1/chat/completions \\\\
  -H "Content-Type: application/json" \\\\
  -d '{
    "model": "free-fast",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'\`,
    python: \`from openai import OpenAI

client = OpenAI(base_url="\${host}/v1", api_key="any")
response = client.chat.completions.create(
    model="free-fast",
    messages=[{"role": "user", "content": "Hello"}],
    stream=True
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="", flush=True)\`,
    ts: \`import OpenAI from "openai";

const client = new OpenAI({ baseURL: "\${host}/v1", apiKey: "any" });
const stream = await client.chat.completions.create({
  model: "free-fast",
  messages: [{ role: "user", content: "Hello" }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}\`
  };

  function setLang(lang, btn) {
    document.querySelectorAll('.snippet-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById("code-snippet").textContent = snippets[lang];
  }

  function copyBaseUrl() {
    navigator.clipboard.writeText(host + "/v1");
  }

  async function loadData() {
    try {
      const [sRes, cRes] = await Promise.all([fetch("/api/status"), fetch("/api/combos")]);
      if (sRes.ok) {
        const s = await sRes.json();
        document.getElementById("t-req").textContent = (s.metrics?.totalRequests ?? 0).toLocaleString();
        document.getElementById("t-tok").textContent = (s.metrics?.totalTokens ?? 0).toLocaleString();
      }
      if (cRes.ok) {
        const c = await cRes.json();
        const combos = c.combos || [];
        document.getElementById("t-com").textContent = combos.length.toString();
        document.getElementById("routes-count").textContent = combos.length + " ACTIVE";

        const container = document.getElementById("routes-container");
        if (combos.length === 0) {
          container.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:12px;font-family:var(--font-mono);font-size:11px">No routes configured.</div>';
        } else {
          container.innerHTML = combos.map(combo => \`
            <div class="route-row">
              <div style="display:flex;align-items:baseline;gap:8px">
                <span class="r-slug">\${combo.id}</span>
                <span class="r-badge">READY</span>
              </div>
              <div class="r-chain">\${combo.targets.map((t, i) => \`[\${i+1}] \${t.providerId}/\${t.model}\`).join(" ➔ ")}</div>
            </div>
          \`).join("");
        }
      }
    } catch {}
  }

  loadData();
  setInterval(loadData, 5000);
</script>
</body>
</html>
`;
