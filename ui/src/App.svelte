<script lang="ts">
  import { onMount } from "svelte";

  interface TargetRoute {
    providerId: string;
    model: string;
    priority?: number;
    timeoutMs?: number;
  }

  interface ModelCombo {
    id: string;
    displayName: string;
    description?: string;
    targets: TargetRoute[];
    enabled: boolean;
  }

  interface Provider {
    id: string;
    name: string;
    baseUrl: string;
    apiKey?: string;
    type: "openai" | "gemini" | "anthropic";
    enabled: boolean;
    oauth?: { type: string; expiresAt?: number; refreshToken?: string };
  }

  interface TelemetryLog {
    id: string;
    timestamp: number;
    model: string;
    targetProvider: string;
    targetModel: string;
    status: number;
    latencyMs: number;
    tokens?: number;
    promptTokens?: number;
    completionTokens?: number;
    error?: string;
  }


  interface ApiKeyRecord {
    id: string;
    name: string;
    key: string;
    createdAt: number;
    expiresAt?: number;
    maxRequests?: number;
    maxTokens?: number;
    maxPromptTokens?: number;
    maxCompletionTokens?: number;
    usedRequests: number;
    usedTokens: number;
    usedPromptTokens: number;
    usedCompletionTokens: number;
    requiredHeaders?: Record<string, string>;
    requiredBodyKeywords?: string[];
    allowedModels?: string[];
    enabled: boolean;
  }

  interface RouteRule {
    id: string;
    pattern: string;
    target: string;
    priority: number;
    enabled: boolean;
  }

  interface Metrics {
    totalRequests: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
  }

  // Inline stroke-icon path map (no emoji, no icon package)
  const ICONS: Record<string, string> = {
    overview: "M22 12h-4l-3 9L9 3l-3 9H2",
    providers: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
    combos: "M16 3h5v5M21 3l-7.5 7.5M8 21H3v-5M3 21l7.5-7.5M16 21h5v-5M21 21l-7.5-7.5",
    logs: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
    playground: "M4 17l6-5-6-5M12 19h8",
    oauth: "M21 2l-2 2M15.5 7.5l3 3L22 7l-3-3M13.39 11.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.778-7.778z",
    keys: "M21 2l-2 2M15.5 7.5l3 3L22 7l-3-3M13.39 11.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.778-7.778z",
    rules: "M4 6h16M4 12h10M4 18h14M18 9l3 3-3 3",
    probe: "M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83",
    bolt: "M13 2 4.09 12.97A1 1 0 0 0 4.86 14.6H11l-1 7.4 8.91-10.97A1 1 0 0 0 18.14 9.4H12z",
    sortAsc: "M11 5h10M11 9h7M11 13h4M3 17l3 3 3-3M6 18V4",
    sortDesc: "M11 5h4M11 9h7M11 13h10M3 7l3-3 3 3M6 6v14",
  };

  type Tab = "overview" | "providers" | "combos" | "keys" | "rules" | "logs" | "playground" | "oauth";

  let activeTab = $state<Tab>("overview");
  let combos = $state<ModelCombo[]>([]);
  let providers = $state<Provider[]>([]);
  let logs = $state<TelemetryLog[]>([]);
  let metrics = $state<Metrics>({ totalRequests: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0 });
  let loading = $state(true);
  let apiKeys = $state<ApiKeyRecord[]>([]);
  let routeRules = $state<RouteRule[]>([]);

  // Provider Probe state
  let probeLoading = $state(false);
  let probeResult = $state<{ valid: boolean; statusCode: number; latencyMs: number; modelCount?: number; error?: string } | null>(null);

  // Key creation state
  let newKeyName = $state("");
  let newKeyExpiry = $state("never");
  let newKeyMaxReq = $state<number | undefined>(undefined);
  let newKeyMaxTokens = $state<number | undefined>(undefined);
  let newKeyMaxPrompt = $state<number | undefined>(undefined);
  let newKeyMaxComp = $state<number | undefined>(undefined);
  let newKeyHeaders = $state("");
  let newKeyBodyKw = $state("");
  let newKeyModels = $state("");

  // Rule creation state
  let newRulePattern = $state("");
  let newRuleTarget = $state("");
  let newRulePriority = $state(10);

  // Playground state extensions
  let playSystem = $state("You are a concise, technical assistant.");
  let playTemp = $state(0.7);
  let playMaxTokens = $state(1000);


  // Auth
  let isAuthenticated = $state(false);
  let authPassword = $state("");
  let authError = $state("");
  let authLoading = $state(false);

  // Range / sort controls
  type Range = "1d" | "7d" | "30d" | "1y" | "custom";
  let range = $state<Range>("1d");
  let customSince = $state("");
  let customUntil = $state("");
  type SortKey = "timestamp" | "latency" | "tokens" | "prompt_tokens" | "completion_tokens";
  let sortBy = $state<SortKey>("timestamp");
  let sortOrder = $state<"asc" | "desc">("desc");

  // Truthful liveness: flips only when a new request is observed
  let liveUntil = $state(0);
  let nowTick = $state(Date.now());
  let lastRequestCount = -1;

  // Forms
  let newComboId = $state("");
  let newComboName = $state("");
  let newComboProvider = $state("");
  let newComboModel = $state("");
  let availableModels = $state<string[]>([]);
  let fetchingModels = $state(false);

  let newProvId = $state("");
  let newProvName = $state("");
  let newProvUrl = $state("");
  let newProvKey = $state("");
  let newProvType = $state<"openai" | "gemini" | "anthropic">("openai");

  let provDrawerMode = $state<"single" | "bulk">("single");
  let bulkSubMode = $state<"pool" | "multi">("pool");
  let bulkTargetProvId = $state("new");
  let bulkProvName = $state("");
  let bulkProvId = $state("");
  let bulkProvType = $state<"openai" | "gemini" | "anthropic">("openai");
  let bulkProvUrl = $state("");
  let bulkKeysInput = $state("");
  let bulkMultiInput = $state("");
  let bulkLoading = $state(false);
  let bulkResultMsg = $state("");

  const detectedPoolKeyCount = $derived(
    bulkKeysInput
      .split(/[\n,;\t]+/)
      .map((line) => line.replace(/(\/\/|#).*$/, "").trim())
      .filter(Boolean).length
  );

  let oauthProviderId = $state("");
  let oauthJson = $state("");
  let oauthStatusMsg = $state("");

  // Config Backup & Migration State
  let showImportModal = $state(false);
  let importRawJson = $state("");
  let importMode = $state<"merge" | "replace">("merge");
  let importLoading = $state(false);
  let importResultMsg = $state("");

  // Mobile Collapsible Drawer State (Opsi B: Top Accordion)
  let mobileDrawerOpen = $state<Record<string, boolean>>({
    providers: false,
    combos: false,
    keys: false,
    rules: false,
  });

  function toggleMobileDrawer(tab: string) {
    mobileDrawerOpen[tab] = !mobileDrawerOpen[tab];
  }

  // Instant Search Queries & Filtered Derivations (500+ ~ 1k items)
  let providerSearch = $state("");
  let comboSearch = $state("");
  let keySearch = $state("");
  let ruleSearch = $state("");

  const filteredProviders = $derived(
    providerSearch.trim() === ""
      ? providers
      : providers.filter((p) => {
          const q = providerSearch.toLowerCase().trim();
          return (
            p.id.toLowerCase().includes(q) ||
            p.name.toLowerCase().includes(q) ||
            p.type.toLowerCase().includes(q) ||
            p.baseUrl.toLowerCase().includes(q)
          );
        })
  );

  const filteredCombos = $derived(
    comboSearch.trim() === ""
      ? combos
      : combos.filter((c) => {
          const q = comboSearch.toLowerCase().trim();
          return (
            c.id.toLowerCase().includes(q) ||
            c.displayName.toLowerCase().includes(q) ||
            c.targets.some(
              (t) =>
                t.providerId.toLowerCase().includes(q) ||
                t.model.toLowerCase().includes(q)
            )
          );
        })
  );

  const filteredApiKeys = $derived(
    keySearch.trim() === ""
      ? apiKeys
      : apiKeys.filter((k) => {
          const q = keySearch.toLowerCase().trim();
          return (
            k.name.toLowerCase().includes(q) ||
            k.key.toLowerCase().includes(q) ||
            (k.allowedModels && k.allowedModels.some((m) => m.toLowerCase().includes(q)))
          );
        })
  );

  const filteredRules = $derived(
    ruleSearch.trim() === ""
      ? routeRules
      : routeRules.filter((r) => {
          const q = ruleSearch.toLowerCase().trim();
          return (
            r.pattern.toLowerCase().includes(q) ||
            r.target.toLowerCase().includes(q)
          );
        })
  );

  let playModel = $state("");
  let playPrompt = $state("Summarize what an isomorphic edge gateway does in two sentences.");
  let playStream = $state(true);
  let playOutput = $state("");
  let playRunning = $state(false);
  let playMeta = $state<{ latency?: number; tokens?: number }>({});

  const isLive = $derived(nowTick < liveUntil);

  // Request activity, last 15 minutes, 32 buckets — derived from real logs
  const activity = $derived.by(() => {
    const BUCKETS = 32;
    const WINDOW = 15 * 60 * 1000;
    const bucketMs = WINDOW / BUCKETS;
    const buckets = new Array<number>(BUCKETS).fill(0);
    const ts = nowTick;
    for (const l of logs) {
      const age = ts - l.timestamp;
      if (age < 0 || age > WINDOW) continue;
      const idx = BUCKETS - 1 - Math.floor(age / bucketMs);
      if (idx >= 0 && idx < BUCKETS) buckets[idx]++;
    }
    return buckets;
  });

  const activeBuckets = $derived(activity.filter((v) => v > 0).length);
  const activityMax = $derived(Math.max(1, ...activity));

  // Per-combo request counts inside the live window (no fabricated animation)
  const comboLoad = $derived.by(() => {
    const WINDOW = 15 * 60 * 1000;
    const map = new Map<string, number>();
    for (const l of logs) {
      if (nowTick - l.timestamp > WINDOW) continue;
      map.set(l.model, (map.get(l.model) ?? 0) + 1);
    }
    return map;
  });

  const activityError = $derived(
    metrics.totalRequests > 0 && (metrics.promptTokens === 0 && metrics.completionTokens === 0)
  );

  function rangeParams(): string {
    if (range === "custom") {
      const parts: string[] = ["timeframe=custom"];
      if (customSince) parts.push(`since=${new Date(customSince).getTime()}`);
      if (customUntil) parts.push(`until=${new Date(customUntil).getTime()}`);
      return parts.join("&");
    }
    return `timeframe=${range}`;
  }

  function getAuthHeaders(): Record<string, string> {
    const token = localStorage.getItem("edge_admin_token") || "";
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function handleLogin() {
    if (!authPassword) return;
    authLoading = true;
    authError = "";
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: authPassword }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        localStorage.setItem("edge_admin_token", data.token);
        isAuthenticated = true;
        authPassword = "";
        await refreshData(true);
        connectLiveStream();
      } else {
        authError = data.error || "Authentication failed";
      }
    } catch {
      authError = "Gateway unreachable";
    } finally {
      authLoading = false;
    }
  }

  function handleLogout() {
    localStorage.removeItem("edge_admin_token");
    if (liveSource) {
      liveSource.close();
      liveSource = null;
    }
    isAuthenticated = false;
  }

  async function loadModelsForProvider(providerId: string) {
    if (!providerId) return;
    fetchingModels = true;
    try {
      const res = await fetch(`/api/providers/${encodeURIComponent(providerId)}/models`, {
        headers: getAuthHeaders(),
      });
      availableModels = res.ok ? (await res.json()).models || [] : [];
    } catch {
      availableModels = [];
    } finally {
      fetchingModels = false;
    }
  }

  $effect(() => {
    if (newComboProvider && isAuthenticated) loadModelsForProvider(newComboProvider);
  });

  let liveSource: EventSource | null = null;

  function connectLiveStream() {
    if (liveSource) {
      liveSource.close();
      liveSource = null;
    }
    const token = localStorage.getItem("edge_admin_token") || "";
    if (!token) return;

    try {
      liveSource = new EventSource(`/api/live?token=${encodeURIComponent(token)}`);
      liveSource.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === "log" && data.log) {
            logs = [data.log, ...logs.filter((l) => l.id !== data.log.id)];
            liveUntil = Date.now() + 3000;
            nowTick = Date.now();
            metrics = {
              totalRequests: metrics.totalRequests + 1,
              totalTokens: metrics.totalTokens + (data.log.tokens || 0),
              promptTokens: metrics.promptTokens + (data.log.promptTokens || 0),
              completionTokens: metrics.completionTokens + (data.log.completionTokens || 0),
            };
          }
        } catch {}
      };
      liveSource.onerror = () => {
        // Auto-reconnects natively or covered by 1s poll
      };
    } catch {}
  }

  async function refreshData(full = false) {
    if (!isAuthenticated) return;
    const limit = activeTab === "logs" ? 200 : 20;
    const qs = `${rangeParams()}&sortBy=${sortBy}&order=${sortOrder}&limit=${limit}`;
    try {
      if (full) {
        const [statusRes, combosRes, provRes, keysRes, rulesRes] = await Promise.all([
          fetch(`/api/status?${qs}`, { headers: getAuthHeaders() }),
          fetch("/api/combos", { headers: getAuthHeaders() }),
          fetch("/api/providers", { headers: getAuthHeaders() }),
          fetch("/api/keys", { headers: getAuthHeaders() }),
          fetch("/api/rules", { headers: getAuthHeaders() }),
        ]);

        if (statusRes.ok) {
          const s = await statusRes.json();
          metrics = s.metrics || metrics;
          logs = s.logs || [];
          if (lastRequestCount >= 0 && metrics.totalRequests > lastRequestCount) {
            liveUntil = Date.now() + 3000;
            nowTick = Date.now();
          }
          lastRequestCount = metrics.totalRequests;
        }
        if (combosRes.ok) {
          const c = await combosRes.json();
          combos = c.combos || [];
          if (combos.length > 0 && !playModel) playModel = combos[0].id;
        }
        if (provRes.ok) {
          const p = await provRes.json();
          providers = p.providers || [];
          if (providers.length > 0 && !newComboProvider) newComboProvider = providers[0].id;
          if (providers.length > 0 && !oauthProviderId) oauthProviderId = providers[0].id;
        }
        if (keysRes.ok) {
          const k = await keysRes.json();
          apiKeys = k.keys || [];
        }
        if (rulesRes.ok) {
          const r = await rulesRes.json();
          routeRules = r.rules || [];
        }
      } else {
        // Lightweight live tick (sub-millisecond SQLite query, zero combo/provider overhead)
        const statusRes = await fetch(`/api/status?${qs}`, { headers: getAuthHeaders() });
        if (statusRes.ok) {
          const s = await statusRes.json();
          metrics = s.metrics || metrics;
          logs = s.logs || [];
          if (lastRequestCount >= 0 && metrics.totalRequests > lastRequestCount) {
            liveUntil = Date.now() + 3000;
            nowTick = Date.now();
          }
          lastRequestCount = metrics.totalRequests;
        }
      }
    } catch (err) {
      console.error("Refresh failed:", err);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    if (localStorage.getItem("edge_admin_token")) {
      isAuthenticated = true;
      refreshData(true);
      connectLiveStream();
    } else {
      loading = false;
    }

    // 1-second live polling tick (only active when tab is visible)
    const poll = setInterval(() => {
      nowTick = Date.now();
      if (isAuthenticated && typeof document !== "undefined" && document.visibilityState === "visible") {
        refreshData(false);
      }
    }, 1000);

    const onVisibility = () => {
      if (document.visibilityState === "visible" && isAuthenticated) {
        refreshData(true);
        if (!liveSource || liveSource.readyState === EventSource.CLOSED) {
          connectLiveStream();
        }
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisibility);
      if (liveSource) liveSource.close();
    };
  });

  function fmtTime(ts: number): string {
    return new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
  }

  function fmtNum(n?: number): string {
    return n === undefined || n === null ? "—" : n.toLocaleString("en-US");
  }

  async function handleAddCombo() {
    if (!newComboId || !newComboName || !newComboProvider || !newComboModel) return;
    await fetch("/api/combos", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({
        id: newComboId.trim().toLowerCase(),
        displayName: newComboName.trim(),
        enabled: true,
        targets: [{ providerId: newComboProvider, model: newComboModel.trim(), priority: 10 }],
      }),
    });
    newComboId = "";
    newComboName = "";
    newComboModel = "";
    await refreshData();
  }

  async function handleDeleteCombo(id: string) {
    if (!confirm(`Delete combo "${id}"?`)) return;
    await fetch(`/api/combos/${encodeURIComponent(id)}`, { method: "DELETE", headers: getAuthHeaders() });
    await refreshData();
  }

  async function handleAddProvider() {
    if (!newProvId || !newProvName || !newProvUrl) return;
    await fetch("/api/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({
        id: newProvId.trim().toLowerCase(),
        name: newProvName.trim(),
        baseUrl: newProvUrl.trim(),
        apiKey: newProvKey.trim() || undefined,
        type: newProvType,
        enabled: true,
      }),
    });
    newProvId = "";
    newProvName = "";
    newProvUrl = "";
    newProvKey = "";
    await refreshData();
  }

  async function handleDeleteProvider(id: string) {
    if (!confirm(`Delete provider "${id}"?`)) return;
    await fetch(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE", headers: getAuthHeaders() });
    await refreshData();
  }

  async function handleImportOAuth() {
    if (!oauthProviderId || !oauthJson) return;
    oauthStatusMsg = "Parsing session...";
    try {
      const res = await fetch("/api/oauth/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ providerId: oauthProviderId, sessionJson: oauthJson }),
      });
      const data = await res.json();
      oauthStatusMsg = res.ok ? `Imported session for ${oauthProviderId}` : `Failed: ${data.error}`;
      if (res.ok) {
        oauthJson = "";
        await refreshData();
      }
    } catch (err) {
      oauthStatusMsg = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }


  async function handleProbeProvider() {
    if (!newProvUrl) return;
    probeLoading = true;
    probeResult = null;
    try {
      const res = await fetch("/api/providers/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          baseUrl: newProvUrl,
          apiKey: newProvKey || undefined,
          type: newProvType,
        }),
      });
      probeResult = await res.json();
    } catch (err) {
      probeResult = { valid: false, statusCode: 0, latencyMs: 0, error: String(err) };
    } finally {
      probeLoading = false;
    }
  }

  async function handleBulkIngest() {
    bulkLoading = true;
    bulkResultMsg = "";
    try {
      let bodyData: any;
      if (bulkSubMode === "pool") {
        if (!bulkKeysInput.trim()) {
          bulkResultMsg = "[Error] Please enter at least 1 API key";
          bulkLoading = false;
          return;
        }
        if (bulkTargetProvId === "new") {
          if (!bulkProvName.trim() || !bulkProvUrl.trim()) {
            bulkResultMsg = "[Error] Provider Name and Base URL are required";
            bulkLoading = false;
            return;
          }
          bodyData = {
            mode: "pool",
            name: bulkProvName.trim(),
            id: bulkProvId.trim() || undefined,
            type: bulkProvType,
            baseUrl: bulkProvUrl.trim(),
            keys: bulkKeysInput.trim(),
          };
        } else {
          bodyData = {
            mode: "pool",
            targetProviderId: bulkTargetProvId,
            keys: bulkKeysInput.trim(),
          };
        }
      } else {
        if (!bulkMultiInput.trim()) {
          bulkResultMsg = "[Error] Payload cannot be empty";
          bulkLoading = false;
          return;
        }
        bodyData = bulkMultiInput.trim();
        if (bodyData.startsWith("{") || bodyData.startsWith("[")) {
          try {
            bodyData = JSON.parse(bodyData);
          } catch {}
        }
      }

      const res = await fetch("/api/providers/bulk", {
        method: "POST",
        headers: {
          "Content-Type": typeof bodyData === "string" ? "text/plain" : "application/json",
          ...getAuthHeaders(),
        },
        body: typeof bodyData === "string" ? bodyData : JSON.stringify(bodyData),
      });

      const text = await res.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Server returned status ${res.status}: ${text.slice(0, 100)}`);
      }

      if (res.ok && data.success) {
        if (data.mode === "pool") {
          bulkResultMsg = `[OK] Pooled ${data.addedKeys} keys into "${data.provider?.name || 'provider'}" (Total in pool: ${data.totalKeysInPool}) [${data.durationMs}ms]`;
          bulkKeysInput = "";
        } else {
          bulkResultMsg = `[OK] Ingested ${data.total} credentials (${data.saved} saved) [${data.durationMs}ms]`;
          bulkMultiInput = "";
        }
        await reloadStatus();
      } else {
        bulkResultMsg = `[Error] ${data.error || text || "Failed"}`;
      }
    } catch (err: any) {
      bulkResultMsg = `[Error] ${err.message}`;
    } finally {
      bulkLoading = false;
    }
  }

  async function handleExportConfig() {
    try {
      const res = await fetch("/api/config/export", {
        headers: getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`Export failed with HTTP ${res.status}`);
      const data = await res.json();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `isoroute-config-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      alert(`Export error: ${err.message}`);
    }
  }

  function handleFileSelect(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      importRawJson = String(reader.result || "");
    };
    reader.readAsText(file);
  }

  async function handleRunImport() {
    if (!importRawJson.trim()) return;
    importLoading = true;
    importResultMsg = "";
    try {
      const res = await fetch(`/api/config/import?mode=${importMode}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        body: importRawJson.trim(),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        const p = data.stats?.providersSaved ?? 0;
        const c = data.stats?.combosSaved ?? 0;
        const pooled = data.stats?.connectionsPooled ? ` (${data.stats.connectionsPooled} keys pooled)` : "";
        importResultMsg = `[OK] Successfully imported ${p} providers${pooled}, ${c} combos (${data.format.toUpperCase()} format) in ${data.durationMs}ms!`;
        await reloadStatus();
      } else {
        importResultMsg = `[Error] ${data.error || "Import failed"}`;
      }
    } catch (err: any) {
      importResultMsg = `[Error] ${err.message}`;
    } finally {
      importLoading = false;
    }
  }

  async function handleAddKey() {
    if (!newKeyName) return;
    let expiresAt: number | undefined = undefined;
    const now = Date.now();
    if (newKeyExpiry === "1d") expiresAt = now + 86400 * 1000;
    else if (newKeyExpiry === "7d") expiresAt = now + 7 * 86400 * 1000;
    else if (newKeyExpiry === "30d") expiresAt = now + 30 * 86400 * 1000;
    else if (newKeyExpiry === "90d") expiresAt = now + 90 * 86400 * 1000;
    else if (newKeyExpiry === "1y") expiresAt = now + 365 * 86400 * 1000;

    let headersObj: Record<string, string> | undefined = undefined;
    if (newKeyHeaders.trim()) {
      try {
        headersObj = JSON.parse(newKeyHeaders.trim());
      } catch {
        headersObj = {};
        for (const line of newKeyHeaders.split("\n")) {
          const idx = line.indexOf(":");
          if (idx !== -1) headersObj[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      }
    }

    const bodyKws = newKeyBodyKw.trim() ? newKeyBodyKw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const modelsArr = newKeyModels.trim() ? newKeyModels.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

    await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({
        name: newKeyName.trim(),
        expiresAt,
        maxRequests: newKeyMaxReq || undefined,
        maxTokens: newKeyMaxTokens || undefined,
        maxPromptTokens: newKeyMaxPrompt || undefined,
        maxCompletionTokens: newKeyMaxComp || undefined,
        requiredHeaders: headersObj,
        requiredBodyKeywords: bodyKws,
        allowedModels: modelsArr,
        enabled: true,
      }),
    });

    newKeyName = "";
    newKeyMaxReq = undefined;
    newKeyMaxTokens = undefined;
    newKeyMaxPrompt = undefined;
    newKeyMaxComp = undefined;
    newKeyHeaders = "";
    newKeyBodyKw = "";
    newKeyModels = "";
    await refreshData(true);
  }

  async function handleDeleteKey(id: string) {
    if (!confirm(`Revoke API key "${id}"?`)) return;
    await fetch(`/api/keys/${encodeURIComponent(id)}`, { method: "DELETE", headers: getAuthHeaders() });
    await refreshData(true);
  }

  async function handleAddRule() {
    if (!newRulePattern || !newRuleTarget) return;
    await fetch("/api/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...getAuthHeaders() },
      body: JSON.stringify({
        pattern: newRulePattern.trim(),
        target: newRuleTarget.trim(),
        priority: Number(newRulePriority) || 10,
        enabled: true,
      }),
    });
    newRulePattern = "";
    newRuleTarget = "";
    newRulePriority = 10;
    await refreshData(true);
  }

  async function handleDeleteRule(id: string) {
    if (!confirm(`Delete rule "${id}"?`)) return;
    await fetch(`/api/rules/${encodeURIComponent(id)}`, { method: "DELETE", headers: getAuthHeaders() });
    await refreshData(true);
  }

  async function handleClearLogs() {
    await fetch("/api/logs/clear", { method: "POST", headers: getAuthHeaders() });
    await refreshData();
  }

  async function handleRunPlayground() {
    if (playRunning || !playPrompt) return;
    playRunning = true;
    playOutput = "";
    playMeta = {};
    const startMs = Date.now();

    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: playModel,
          messages: [
            ...(playSystem.trim() ? [{ role: "system", content: playSystem.trim() }] : []),
            { role: "user", content: playPrompt }
          ],
          stream: playStream,
          temperature: Number(playTemp),
          max_tokens: Number(playMaxTokens),
        }),
      });

      if (!res.ok) {
        playOutput = `HTTP ${res.status}\n${await res.text()}`;
        return;
      }

      if (playStream && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ") || trimmed === "data: [DONE]") continue;
            try {
              const json = JSON.parse(trimmed.slice(6));
              playOutput += json.choices?.[0]?.delta?.content || "";
              if (json.usage) playMeta.tokens = json.usage.total_tokens;
            } catch {}
          }
        }
      } else {
        const json = await res.json();
        playOutput = json.choices?.[0]?.message?.content || JSON.stringify(json, null, 2);
        if (json.usage) playMeta.tokens = json.usage.total_tokens;
      }
      playMeta.latency = Date.now() - startMs;
    } catch (err) {
      playOutput = `Request failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      playRunning = false;
      refreshData();
    }
  }
</script>

{#snippet icon(path: string, size = 15)}
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d={path} />
  </svg>
{/snippet}

{#if !isAuthenticated}
  <div class="auth-gate">
    <div class="auth-card">
      <div class="auth-head">
        <span class="brand-mark">{@render icon(ICONS.bolt, 16)}</span>
        <div>
          <h1>IsoRoute</h1>
          <span class="auth-sub">Gateway control plane</span>
        </div>
      </div>

      <form onsubmit={(e) => { e.preventDefault(); handleLogin(); }} class="auth-form">
        <div class="field">
          <label for="admin-pwd">Password</label>
          <input id="admin-pwd" type="password" bind:value={authPassword} placeholder="••••••" />
        </div>
        {#if authError}
          <div class="err-box">{authError}</div>
        {/if}
        <button class="btn-brand wide" disabled={authLoading}>
          {authLoading ? "Authenticating…" : "Sign in"}
        </button>
      </form>

      <div class="auth-foot"><a href="/">← Public status</a></div>
    </div>
  </div>
{:else}
  <div class="app-layout">
    <aside class="sidebar">
      <div class="sidebar-brand">
        <span class="brand-mark">{@render icon(ICONS.bolt, 15)}</span>
        <div class="brand-titles">
          <span class="brand-name">IsoRoute</span>
          <span class="brand-tag">v0.2.0</span>
        </div>
      </div>

      <nav class="sidebar-nav">
        <button class="nav-item" class:active={activeTab === 'overview'} onclick={() => activeTab = 'overview'}>
          {@render icon(ICONS.overview)}<span>Overview</span>
        </button>
        <button class="nav-item" class:active={activeTab === 'providers'} onclick={() => activeTab = 'providers'}>
          {@render icon(ICONS.providers)}<span>Providers</span>
          <span class="pill-count">{providers.length}</span>
        </button>
        <button class="nav-item" class:active={activeTab === 'combos'} onclick={() => activeTab = 'combos'}>
          {@render icon(ICONS.combos)}<span>Combos</span>
          <span class="pill-count">{combos.length}</span>
        </button>
        <button class="nav-item" class:active={activeTab === 'keys'} onclick={() => activeTab = 'keys'}>
          {@render icon(ICONS.keys)}<span>API Keys</span>
          <span class="pill-count">{apiKeys.length}</span>
        </button>
        <button class="nav-item" class:active={activeTab === 'rules'} onclick={() => activeTab = 'rules'}>
          {@render icon(ICONS.rules)}<span>Force Routing</span>
          <span class="pill-count">{routeRules.length}</span>
        </button>
        <button class="nav-item" class:active={activeTab === 'logs'} onclick={() => activeTab = 'logs'}>
          {@render icon(ICONS.logs)}<span>Logs</span>
        </button>
        <button class="nav-item" class:active={activeTab === 'playground'} onclick={() => activeTab = 'playground'}>
          {@render icon(ICONS.playground)}<span>Playground</span>
        </button>
        <button class="nav-item" class:active={activeTab === 'oauth'} onclick={() => activeTab = 'oauth'}>
          {@render icon(ICONS.oauth)}<span>Sessions</span>
        </button>
      </nav>

      <div class="sidebar-footer">
        <div class="user-pill">
          <div class="user-meta">
            <span class="u-name">admin</span>
            <span class="u-host">{window.location.host}</span>
          </div>
        </div>
        <div class="footer-actions">
          <a href="/" class="btn-subtle">Public</a>
          <button class="btn-subtle" onclick={handleLogout}>Sign out</button>
        </div>
      </div>
    </aside>

    <div class="workspace">
      <header class="topbar">
        <div class="topbar-title">
          {#if activeTab === 'overview'}Overview
          {:else if activeTab === 'providers'}Providers
          {:else if activeTab === 'combos'}Combos
          {:else if activeTab === 'keys'}API Keys & Billing
          {:else if activeTab === 'rules'}Force Routing
          {:else if activeTab === 'logs'}Logs
          {:else if activeTab === 'playground'}Playground
          {:else if activeTab === 'oauth'}Sessions
          {/if}
        </div>
        <div class="topbar-actions">
          {#if isLive}
            <span class="live-tag"><span class="live-bar"></span>live</span>
          {/if}
          <button class="btn-subtle mobile-action" title="Export full configuration JSON" onclick={handleExportConfig}>Export</button>
          <button class="btn-subtle mobile-action" title="Import configuration JSON (IsoRoute or 9Router)" onclick={() => { showImportModal = true; importResultMsg = ''; }}>Import</button>
          <a href="/" class="btn-subtle mobile-action">Public</a>
          <button class="btn-subtle mobile-action" onclick={handleLogout}>Sign out</button>
        </div>
      </header>

      <main class="content-body">
        {#if activeTab === 'overview'}
          <div class="tab-pane">
            <div class="metrics-row">
              <div class="metric-card">
                <span class="met-label">Requests</span>
                <span class="met-val">{fmtNum(metrics.totalRequests)}</span>
              </div>
              <div class="metric-card">
                <span class="met-label">Input tokens</span>
                <span class="met-val">{fmtNum(metrics.promptTokens)}</span>
              </div>
              <div class="metric-card">
                <span class="met-label">Output tokens</span>
                <span class="met-val">{fmtNum(metrics.completionTokens)}</span>
              </div>
              <div class="metric-card">
                <span class="met-label">Total tokens</span>
                <span class="met-val">{fmtNum(metrics.totalTokens)}</span>
              </div>
            </div>

            <div class="toolbar">
              <div class="seg" role="group" aria-label="Time range">
                {#each [["1d", "1D"], ["7d", "7D"], ["30d", "30D"], ["1y", "1Y"], ["custom", "Custom"]] as [key, label]}
                  <button
                    class="seg-btn"
                    class:on={range === key}
                    onclick={() => { range = key as Range; refreshData(); }}
                  >{label}</button>
                {/each}
              </div>

              {#if range === "custom"}
                <div class="custom-range">
                  <input type="datetime-local" bind:value={customSince} aria-label="Since" />
                  <span class="range-sep">→</span>
                  <input type="datetime-local" bind:value={customUntil} aria-label="Until" />
                  <button class="btn-subtle" onclick={refreshData}>Apply</button>
                </div>
              {/if}

              <div class="sort-controls">
                <select bind:value={sortBy} onchange={refreshData} aria-label="Sort by">
                  <option value="timestamp">Time</option>
                  <option value="latency">Latency</option>
                  <option value="tokens">Total tokens</option>
                  <option value="prompt_tokens">Input tokens</option>
                  <option value="completion_tokens">Output tokens</option>
                </select>
                <button
                  class="btn-icon"
                  title={sortOrder === 'desc' ? "Descending" : "Ascending"}
                  aria-label="Toggle sort order"
                  onclick={() => { sortOrder = sortOrder === 'desc' ? 'asc' : 'desc'; refreshData(); }}
                >
                  {@render icon(sortOrder === 'desc' ? ICONS.sortDesc : ICONS.sortAsc)}
                </button>
              </div>
            </div>

            {#if activityError}
              <div class="notice">
                Input/output token split is unavailable for records captured before this build. Newer requests populate it automatically.
              </div>
            {/if}

            <!-- Activity strip: reflects real request timestamps only -->
            <div class="section-box">
              <div class="box-head">
                <span class="box-title">Request activity</span>
                <span class="box-meta">last 15 min · {activeBuckets}/32 active</span>
              </div>
              <div class="activity-strip" aria-hidden="true">
                {#each activity as v, i}
                  <span
                    class="act-bar"
                    class:on={v > 0}
                    style={`height:${v === 0 ? 2 : Math.max(4, Math.round((v / activityMax) * 34))}px`}
                  ></span>
                {/each}
              </div>
            </div>

            <!-- Routes: compact, no orbital graph, no fake animation -->
            <div class="section-box">
              <div class="box-head">
                <span class="box-title">Routes</span>
                <span class="box-meta">calls in last 15 min</span>
              </div>
              <div class="route-list">
                {#each combos as combo (combo.id)}
                  {@const load = comboLoad.get(combo.id) ?? 0}
                  <div class="route-line" class:flowing={load > 0}>
                    <span class="route-slug">{combo.id}</span>
                    <span class="route-chain">
                      {#each combo.targets as t, i}
                        {i > 0 ? " → " : ""}{t.providerId}/{t.model}
                      {/each}
                    </span>
                    <span class="route-load" class:zero={load === 0}>{load === 0 ? "idle" : `${load} req`}</span>
                  </div>
                {/each}
                {#if combos.length === 0}
                  <div class="empty-cell">No routes configured.</div>
                {/if}
              </div>
            </div>

            <div class="section-box">
              <div class="box-head">
                <span class="box-title">Recent requests</span>
                <button class="btn-subtle" onclick={() => activeTab = 'logs'}>All logs</button>
              </div>

              <div class="table-container desktop-only">
                <table class="dense-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Combo</th>
                      <th>Target</th>
                      <th>Status</th>
                      <th>Latency</th>
                      <th>In</th>
                      <th>Out</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each logs.slice(0, 4) as log (log.id)}
                      <tr>
                        <td class="mono">{fmtTime(log.timestamp)}</td>
                        <td class="mono strong">{log.model}</td>
                        <td class="mono dim">{log.targetProvider}/{log.targetModel}</td>
                        <td><span class="status-badge" class:s-ok={log.status === 200} class:s-warn={log.status === 429} class:s-err={log.status >= 500}>{log.status}</span></td>
                        <td class="mono">{log.latencyMs} ms</td>
                        <td class="mono">{fmtNum(log.promptTokens)}</td>
                        <td class="mono">{fmtNum(log.completionTokens)}</td>
                      </tr>
                    {/each}
                    {#if logs.length === 0}
                      <tr><td colspan="7" class="empty-cell">No requests in this range.</td></tr>
                    {/if}
                  </tbody>
                </table>
              </div>

              <div class="mobile-feed mobile-only">
                {#each logs.slice(0, 4) as log (log.id)}
                  <div class="feed-item">
                    <div class="feed-top">
                      <span class="feed-model">{log.model}</span>
                      <span class="status-badge" class:s-ok={log.status === 200} class:s-warn={log.status === 429} class:s-err={log.status >= 500}>{log.status}</span>
                    </div>
                    <div class="feed-target">{log.targetProvider}/{log.targetModel}</div>
                    <div class="feed-meta">
                      <span>{fmtTime(log.timestamp)}</span>
                      <span>·</span>
                      <span>{log.latencyMs} ms</span>
                      <span>·</span>
                      <span>in {fmtNum(log.promptTokens)}</span>
                      <span>·</span>
                      <span>out {fmtNum(log.completionTokens)}</span>
                    </div>
                  </div>
                {/each}
                {#if logs.length === 0}
                  <div class="empty-cell">No requests in this range.</div>
                {/if}
              </div>

              {#if logs.length > 4}
                <div class="box-foot-action">
                  <button class="btn-subtle" onclick={() => activeTab = 'logs'}>
                    View all {logs.length} logs in Request Logs ➔
                  </button>
                </div>
              {/if}
            </div>
          </div>

        {:else if activeTab === 'providers'}
          <div class="tab-pane">
            <div class="split-layout">
              <div class="card-list">
                <div class="search-bar">
                  <input
                    type="text"
                    class="search-input"
                    placeholder="Search providers (id, name, url)..."
                    bind:value={providerSearch}
                  />
                  {#if providerSearch}
                    <button class="search-clear" onclick={() => providerSearch = ''} title="Clear">✕</button>
                  {/if}
                  <span class="search-count">{filteredProviders.length}/{providers.length}</span>
                </div>

                {#each filteredProviders as prov (prov.id)}
                  <div class="item-card">
                    <div class="card-head">
                      <div class="title-group">
                        <span class="type-chip">{prov.type}</span>
                        <span class="item-name">{prov.name}</span>
                        <code class="item-slug">{prov.id}</code>
                      </div>
                      <button class="btn-danger" onclick={() => handleDeleteProvider(prov.id)}>Delete</button>
                    </div>
                    <div class="detail-row"><span class="d-label">Base URL</span><code class="d-val">{prov.baseUrl}</code></div>
                    {#if prov.apiKey}
                      <div class="detail-row"><span class="d-label">Keys</span><span class="d-val">{prov.apiKey.split(",").length} in pool</span></div>
                    {/if}
                    {#if prov.oauth}
                      <div class="detail-row"><span class="d-label">Session</span><span class="d-val">{prov.oauth.type}</span></div>
                    {/if}
                  </div>
                {/each}
                {#if providers.length === 0}
                  <div class="empty-cell">No providers registered.</div>
                {:else if filteredProviders.length === 0}
                  <div class="empty-cell">No providers matching "{providerSearch}"</div>
                {/if}
              </div>

              <div class="drawer-box" class:mobile-open={mobileDrawerOpen['providers']}>
                <div class="drawer-header-row">
                  <div class="drawer-title-group">
                    <div class="drawer-title">{provDrawerMode === 'single' ? "Register provider" : "Bulk Ingest"}</div>
                    <button type="button" class="drawer-mobile-btn mobile-only" onclick={() => toggleMobileDrawer('providers')}>
                      {mobileDrawerOpen['providers'] ? "Hide" : "+ Add / Bulk"}
                    </button>
                  </div>
                  <div class="subtab-group">
                    <button class="subtab-btn" class:active={provDrawerMode === 'single'} onclick={() => { provDrawerMode = 'single'; mobileDrawerOpen['providers'] = true; }}>Single</button>
                    <button class="subtab-btn" class:active={provDrawerMode === 'bulk'} onclick={() => { provDrawerMode = 'bulk'; mobileDrawerOpen['providers'] = true; }}>Bulk</button>
                  </div>
                </div>

                <div class="drawer-collapsible-body">
                {#if provDrawerMode === 'single'}
                  <div class="field">
                    <label for="p-id">ID</label>
                    <input id="p-id" bind:value={newProvId} placeholder="google-studio" />
                  </div>
                  <div class="field">
                    <label for="p-type">Protocol</label>
                    <select id="p-type" bind:value={newProvType}>
                      <option value="openai">OpenAI compatible</option>
                      <option value="gemini">Google Gemini</option>
                      <option value="anthropic">Anthropic Messages</option>
                    </select>
                  </div>
                  <div class="field">
                    <label for="p-name">Name</label>
                    <input id="p-name" bind:value={newProvName} placeholder="Google AI Studio" />
                  </div>
                  <div class="field">
                    <label for="p-url">Base URL</label>
                    <input id="p-url" bind:value={newProvUrl} placeholder="https://generativelanguage.googleapis.com" />
                  </div>
                  <div class="field">
                    <label for="p-key">API keys (comma separated)</label>
                    <input id="p-key" type="password" bind:value={newProvKey} placeholder="key-1, key-2" />
                  </div>
                  <div class="action-row">
                    <button class="btn-brand" onclick={handleAddProvider}>Register</button>
                    <button class="btn-subtle" disabled={probeLoading || !newProvUrl} onclick={handleProbeProvider}>
                      {probeLoading ? "Probing..." : "Probe & Test Key"}
                    </button>
                  </div>
                  {#if probeResult}
                    <div class="probe-box" class:probe-ok={probeResult.valid} class:probe-err={!probeResult.valid}>
                      {#if probeResult.valid}
                        <span class="probe-status">HTTP {probeResult.statusCode} OK · {probeResult.latencyMs}ms · {probeResult.modelCount} models</span>
                      {:else}
                        <span class="probe-err-msg">{probeResult.error || "Probe failed"}</span>
                      {/if}
                    </div>
                  {/if}
                {:else}
                  <div class="sub-mode-selector">
                    <button class="sub-mode-btn" class:active={bulkSubMode === 'pool'} onclick={() => bulkSubMode = 'pool'}>
                      Pool Keys into Provider
                    </button>
                    <button class="sub-mode-btn" class:active={bulkSubMode === 'multi'} onclick={() => bulkSubMode = 'multi'}>
                      Multi / Auto-detect
                    </button>
                  </div>

                  {#if bulkSubMode === 'pool'}
                    <div class="field">
                      <label for="b-target">Target Provider</label>
                      <select id="b-target" bind:value={bulkTargetProvId}>
                        <option value="new">+ Create New Provider...</option>
                        {#each providers as p}
                          <option value={p.id}>Append to: {p.name} ({p.id})</option>
                        {/each}
                      </select>
                    </div>

                    {#if bulkTargetProvId === 'new'}
                      <div class="field">
                        <label for="b-name">Provider Name</label>
                        <input id="b-name" bind:value={bulkProvName} placeholder="Groq Cloud Pool" />
                      </div>
                      <div class="field">
                        <label for="b-id">ID (Optional)</label>
                        <input id="b-id" bind:value={bulkProvId} placeholder="groq-cloud (auto from name)" />
                      </div>
                      <div class="field">
                        <label for="b-type">Protocol</label>
                        <select id="b-type" bind:value={bulkProvType}>
                          <option value="openai">OpenAI compatible</option>
                          <option value="gemini">Google Gemini</option>
                          <option value="anthropic">Anthropic Messages</option>
                        </select>
                      </div>
                      <div class="field">
                        <label for="b-url">Base URL</label>
                        <input id="b-url" bind:value={bulkProvUrl} placeholder="https://api.groq.com/openai/v1" />
                      </div>
                    {:else}
                      {@const selectedTarget = providers.find(p => p.id === bulkTargetProvId)}
                      {#if selectedTarget}
                        <div class="target-info-card">
                          <div><strong>Base URL:</strong> <code>{selectedTarget.baseUrl}</code></div>
                          <div><strong>Protocol:</strong> <span class="type-chip">{selectedTarget.type}</span> · <strong>Existing Keys:</strong> {selectedTarget.apiKey ? selectedTarget.apiKey.split(/[\n,]/).filter(Boolean).length : 0} in pool</div>
                        </div>
                      {/if}
                    {/if}

                    <div class="field">
                      <div class="label-row">
                        <label for="b-keys">API Keys (1 per line or comma-separated)</label>
                        <span class="keys-detected-tag">{detectedPoolKeyCount} keys detected</span>
                      </div>
                      <textarea
                        id="b-keys"
                        class="bulk-textarea"
                        bind:value={bulkKeysInput}
                        placeholder={`sk-key-1\nsk-key-2\nsk-key-3...`}
                        rows="6"
                      ></textarea>
                    </div>

                    <div class="action-row">
                      <button class="btn-brand" disabled={bulkLoading || detectedPoolKeyCount === 0} onclick={handleBulkIngest}>
                        {bulkLoading ? "Ingesting..." : `Ingest ${detectedPoolKeyCount} keys`}
                      </button>
                    </div>
                  {:else}
                    <div class="bulk-help-banner">
                      Auto-detects Nvidia (<code>nvapi-</code>), Anthropic (<code>sk-ant-</code>), Gemini (<code>AIzaSy</code>), Groq (<code>gsk_</code>), OpenRouter (<code>sk-or-</code>), Cookie headers, or OAuth Session JSON.
                    </div>
                    <div class="field">
                      <label for="bulk-inp">Raw Payload / Multiple Credentials</label>
                      <textarea
                        id="bulk-inp"
                        class="bulk-textarea"
                        bind:value={bulkMultiInput}
                        placeholder={`nvapi-abcdef1234567890...\nsk-ant-api03-abcdef...\nCookie: session_token=xyz123...\n{"access_token":"...","refreshToken":"..."}`}
                        rows="7"
                      ></textarea>
                    </div>
                    <div class="action-row">
                      <button class="btn-brand" disabled={bulkLoading || !bulkMultiInput.trim()} onclick={handleBulkIngest}>
                        {bulkLoading ? "Ingesting..." : "Ingest batch"}
                      </button>
                    </div>
                  {/if}

                  {#if bulkResultMsg}
                    <div class="bulk-result-badge" class:badge-err={bulkResultMsg.startsWith('[Error]')}>{bulkResultMsg}</div>
                  {/if}
                {/if}
                </div>
              </div>
            </div>
          </div>

        {:else if activeTab === 'combos'}
          <div class="tab-pane">
            <div class="split-layout">
              <div class="card-list">
                <div class="search-bar">
                  <input
                    type="text"
                    class="search-input"
                    placeholder="Search combos or upstream models..."
                    bind:value={comboSearch}
                  />
                  {#if comboSearch}
                    <button class="search-clear" onclick={() => comboSearch = ''} title="Clear">✕</button>
                  {/if}
                  <span class="search-count">{filteredCombos.length}/{combos.length}</span>
                </div>

                {#each filteredCombos as combo (combo.id)}
                  {@const load = comboLoad.get(combo.id) ?? 0}
                  <div class="item-card">
                    <div class="card-head">
                      <div class="title-group">
                        <code class="item-slug accent">{combo.id}</code>
                        <span class="item-name">{combo.displayName}</span>
                      </div>
                      <button class="btn-danger" onclick={() => handleDeleteCombo(combo.id)}>Delete</button>
                    </div>
                    <div class="ladder">
                      {#each combo.targets as t, i}
                        <div class="ladder-step">
                          <span class="step-idx">{i + 1}</span>
                          <span class="step-prov">{t.providerId}</span>
                          <span class="step-arr">→</span>
                          <code class="step-model">{t.model}</code>
                          <span class="step-prio">p{t.priority ?? 0}</span>
                        </div>
                      {/each}
                    </div>
                    <div class="detail-row"><span class="d-label">Load</span><span class="d-val">{load === 0 ? "idle" : `${load} req / 15 min`}</span></div>
                  </div>
                {/each}
                {#if combos.length === 0}
                  <div class="empty-cell">No combos configured.</div>
                {:else if filteredCombos.length === 0}
                  <div class="empty-cell">No combos matching "{comboSearch}"</div>
                {/if}
              </div>

              <div class="drawer-box" class:mobile-open={mobileDrawerOpen['combos']}>
                <div class="drawer-header-row">
                  <div class="drawer-title-group">
                    <div class="drawer-title">Create combo</div>
                    <button type="button" class="drawer-mobile-btn mobile-only" onclick={() => toggleMobileDrawer('combos')}>
                      {mobileDrawerOpen['combos'] ? "Hide" : "+ Create Combo"}
                    </button>
                  </div>
                </div>

                <div class="drawer-collapsible-body">
                  <div class="field">
                    <label for="c-id">ID</label>
                    <input id="c-id" bind:value={newComboId} placeholder="coder-latest" />
                  </div>
                  <div class="field">
                    <label for="c-name">Name</label>
                    <input id="c-name" bind:value={newComboName} placeholder="Coder ladder" />
                  </div>
                  <div class="field">
                    <label for="c-prov">Provider</label>
                    <select id="c-prov" bind:value={newComboProvider}>
                      {#each providers as prov}
                        <option value={prov.id}>{prov.name} ({prov.id})</option>
                      {/each}
                    </select>
                  </div>
                  <div class="field">
                    <label for="c-model">
                      Upstream model
                      {#if fetchingModels}<span class="hint">discovering…</span>
                      {:else if availableModels.length > 0}<span class="hint">{availableModels.length} found</span>{/if}
                    </label>
                    <input id="c-model" list="models-dl" bind:value={newComboModel} placeholder="gemini-3-flash" />
                    <datalist id="models-dl">
                      {#each availableModels as m}<option value={m}></option>{/each}
                    </datalist>
                  </div>
                  <button class="btn-brand" onclick={handleAddCombo}>Create</button>
                </div>
              </div>
            </div>
          </div>

{:else if activeTab === 'keys'}
          <div class="tab-pane">
            <div class="split-layout">
              <div class="card-list">
                <div class="search-bar">
                  <input
                    type="text"
                    class="search-input"
                    placeholder="Search keys by name or snippet..."
                    bind:value={keySearch}
                  />
                  {#if keySearch}
                    <button class="search-clear" onclick={() => keySearch = ''} title="Clear">✕</button>
                  {/if}
                  <span class="search-count">{filteredApiKeys.length}/{apiKeys.length}</span>
                </div>

                {#each filteredApiKeys as k (k.id)}
                  {@const isExpired = k.expiresAt && Date.now() > k.expiresAt}
                  {@const isExhausted = (k.maxRequests && k.usedRequests >= k.maxRequests) || (k.maxTokens && k.usedTokens >= k.maxTokens)}
                  <div class="item-card">
                    <div class="card-head">
                      <div class="title-group">
                        <span class="type-chip" class:s-err={!k.enabled || isExpired || isExhausted} class:s-ok={k.enabled && !isExpired && !isExhausted}>
                          {isExpired ? "EXPIRED" : isExhausted ? "EXHAUSTED" : k.enabled ? "ACTIVE" : "DISABLED"}
                        </span>
                        <span class="item-name">{k.name}</span>
                        <code class="item-slug">{k.key.slice(0, 12)}...{k.key.slice(-4)}</code>
                      </div>
                      <button class="btn-danger" onclick={() => handleDeleteKey(k.id)}>Revoke</button>
                    </div>

                    <div class="detail-row">
                      <span class="d-label">Raw Key</span>
                      <code class="d-val selectable">{k.key}</code>
                    </div>

                    <div class="detail-row">
                      <span class="d-label">Requests</span>
                      <span class="d-val">{k.usedRequests.toLocaleString()} / {k.maxRequests ? k.maxRequests.toLocaleString() : "Unlimited"}</span>
                    </div>

                    <div class="detail-row">
                      <span class="d-label">Tokens</span>
                      <span class="d-val">{k.usedTokens.toLocaleString()} / {k.maxTokens ? k.maxTokens.toLocaleString() : "Unlimited"} (in {k.usedPromptTokens.toLocaleString()} · out {k.usedCompletionTokens.toLocaleString()})</span>
                    </div>

                    <div class="detail-row">
                      <span class="d-label">Expires</span>
                      <span class="d-val">{k.expiresAt ? new Date(k.expiresAt).toLocaleDateString("en-GB") : "Never"}</span>
                    </div>

                    {#if k.allowedModels && k.allowedModels.length > 0}
                      <div class="detail-row"><span class="d-label">Models</span><span class="d-val">{k.allowedModels.join(", ")}</span></div>
                    {/if}

                    {#if k.requiredHeaders}
                      <div class="detail-row"><span class="d-label">Guards</span><span class="d-val">{JSON.stringify(k.requiredHeaders)}</span></div>
                    {/if}
                  </div>
                {/each}
                {#if apiKeys.length === 0}
                  <div class="empty-cell">No consumer API keys issued yet.</div>
                {:else if filteredApiKeys.length === 0}
                  <div class="empty-cell">No keys matching "{keySearch}"</div>
                {/if}
              </div>

              <div class="drawer-box" class:mobile-open={mobileDrawerOpen['keys']}>
                <div class="drawer-header-row">
                  <div class="drawer-title-group">
                    <div class="drawer-title">Issue Consumer API Key</div>
                    <button type="button" class="drawer-mobile-btn mobile-only" onclick={() => toggleMobileDrawer('keys')}>
                      {mobileDrawerOpen['keys'] ? "Hide" : "+ Issue Key"}
                    </button>
                  </div>
                </div>

                <div class="drawer-collapsible-body">
                <div class="field">
                  <label for="k-name">Key Name / Client ID</label>
                  <input id="k-name" bind:value={newKeyName} placeholder="production-mobile-app" />
                </div>
                <div class="field">
                  <label for="k-exp">Expiration Duration</label>
                  <select id="k-exp" bind:value={newKeyExpiry}>
                    <option value="never">Never expires</option>
                    <option value="1d">1 Day</option>
                    <option value="7d">7 Days</option>
                    <option value="30d">30 Days</option>
                    <option value="90d">90 Days</option>
                    <option value="1y">1 Year</option>
                  </select>
                </div>
                <div class="field">
                  <label for="k-req">Max Requests (optional)</label>
                  <input id="k-req" type="number" bind:value={newKeyMaxReq} placeholder="1000" />
                </div>
                <div class="field">
                  <label for="k-tokens">Max Total Tokens (optional)</label>
                  <input id="k-tokens" type="number" bind:value={newKeyMaxTokens} placeholder="1000000" />
                </div>
                <div class="field">
                  <label for="k-in-tokens">Max Input Tokens (optional)</label>
                  <input id="k-in-tokens" type="number" bind:value={newKeyMaxPrompt} placeholder="500000" />
                </div>
                <div class="field">
                  <label for="k-out-tokens">Max Output Tokens (optional)</label>
                  <input id="k-out-tokens" type="number" bind:value={newKeyMaxComp} placeholder="500000" />
                </div>
                <div class="field">
                  <label for="k-models">Allowed Models (wildcards, comma-sep)</label>
                  <input id="k-models" bind:value={newKeyModels} placeholder="free-*, claude-*, gemini-*" />
                </div>
                <div class="field">
                  <label for="k-head">Required Headers Guard (Header: Value or JSON)</label>
                  <textarea id="k-head" rows="2" bind:value={newKeyHeaders} placeholder="x-client-id: my-app"></textarea>
                </div>
                <div class="field">
                  <label for="k-body">Required Body Signatures (comma-separated)</label>
                  <input id="k-body" bind:value={newKeyBodyKw} placeholder="authorized_client, v2" />
                </div>
                <button class="btn-brand" onclick={handleAddKey}>Generate API Key</button>
                </div>
              </div>
            </div>
          </div>

        {:else if activeTab === 'rules'}
          <div class="tab-pane">
            <div class="split-layout">
              <div class="card-list">
                <div class="search-bar">
                  <input
                    type="text"
                    class="search-input"
                    placeholder="Search pattern or target..."
                    bind:value={ruleSearch}
                  />
                  {#if ruleSearch}
                    <button class="search-clear" onclick={() => ruleSearch = ''} title="Clear">✕</button>
                  {/if}
                  <span class="search-count">{filteredRules.length}/{routeRules.length}</span>
                </div>

                {#each filteredRules as r (r.id)}
                  <div class="item-card">
                    <div class="card-head">
                      <div class="title-group">
                        <span class="type-chip">p{r.priority}</span>
                        <code class="item-slug accent">{r.pattern}</code>
                        <span class="step-arr">➔</span>
                        <code class="item-slug text-white">{r.target}</code>
                      </div>
                      <button class="btn-danger" onclick={() => handleDeleteRule(r.id)}>Delete</button>
                    </div>
                  </div>
                {/each}
                {#if routeRules.length === 0}
                  <div class="empty-cell">No force routing rewrite rules configured yet.</div>
                {:else if filteredRules.length === 0}
                  <div class="empty-cell">No rules matching "{ruleSearch}"</div>
                {/if}
              </div>

              <div class="drawer-box" class:mobile-open={mobileDrawerOpen['rules']}>
                <div class="drawer-header-row">
                  <div class="drawer-title-group">
                    <div class="drawer-title">Create Force Routing Rule</div>
                    <button type="button" class="drawer-mobile-btn mobile-only" onclick={() => toggleMobileDrawer('rules')}>
                      {mobileDrawerOpen['rules'] ? "Hide" : "+ Add Rule"}
                    </button>
                  </div>
                </div>

                <div class="drawer-collapsible-body">
                  <div class="field">
                    <label for="r-pat">Match Pattern (Wildcard / Regex)</label>
                    <input id="r-pat" bind:value={newRulePattern} placeholder="claude-*-opus / *high / claude*" />
                  </div>
                  <div class="field">
                    <label for="r-tgt">Rewrite Target (Model / Combo / Group)</label>
                    <input id="r-tgt" bind:value={newRuleTarget} placeholder="gemini-$1-latest / deepseek-v4.1-flash / gemini*" />
                  </div>
                  <div class="field">
                    <label for="r-prio">Priority (higher runs first)</label>
                    <input id="r-prio" type="number" bind:value={newRulePriority} placeholder="10" />
                  </div>
                  <button class="btn-brand" onclick={handleAddRule}>Add Routing Rule</button>
                </div>
              </div>
            </div>
          </div>

                {:else if activeTab === 'logs'}
          <div class="tab-pane">
            <div class="toolbar">
              <div class="seg" role="group" aria-label="Time range">
                {#each [["1d", "1D"], ["7d", "7D"], ["30d", "30D"], ["1y", "1Y"], ["custom", "Custom"]] as [key, label]}
                  <button class="seg-btn" class:on={range === key} onclick={() => { range = key as Range; refreshData(); }}>{label}</button>
                {/each}
              </div>
              <div class="sort-controls">
                <select bind:value={sortBy} onchange={refreshData} aria-label="Sort by">
                  <option value="timestamp">Time</option>
                  <option value="latency">Latency</option>
                  <option value="tokens">Total tokens</option>
                  <option value="prompt_tokens">Input tokens</option>
                  <option value="completion_tokens">Output tokens</option>
                </select>
                <button class="btn-icon" aria-label="Toggle sort order" onclick={() => { sortOrder = sortOrder === 'desc' ? 'asc' : 'desc'; refreshData(); }}>
                  {@render icon(sortOrder === 'desc' ? ICONS.sortDesc : ICONS.sortAsc)}
                </button>
                <button class="btn-subtle" onclick={handleClearLogs}>Clear</button>
              </div>
            </div>

            {#if range === "custom"}
              <div class="custom-range">
                <input type="datetime-local" bind:value={customSince} aria-label="Since" />
                <span class="range-sep">→</span>
                <input type="datetime-local" bind:value={customUntil} aria-label="Until" />
                <button class="btn-subtle" onclick={refreshData}>Apply</button>
              </div>
            {/if}

            <div class="section-box">
              <div class="table-container">
                <table class="dense-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Combo</th>
                      <th>Target</th>
                      <th>Status</th>
                      <th>Latency</th>
                      <th>In</th>
                      <th>Out</th>
                      <th>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each logs as log (log.id)}
                      <tr>
                        <td class="mono">{fmtTime(log.timestamp)}</td>
                        <td class="mono strong">{log.model}</td>
                        <td class="mono dim">{log.targetProvider}/{log.targetModel}</td>
                        <td><span class="status-badge" class:s-ok={log.status === 200} class:s-warn={log.status === 429} class:s-err={log.status >= 500}>{log.status}</span></td>
                        <td class="mono">{log.latencyMs} ms</td>
                        <td class="mono">{fmtNum(log.promptTokens)}</td>
                        <td class="mono">{fmtNum(log.completionTokens)}</td>
                        <td class="mono">{fmtNum(log.tokens)}</td>
                      </tr>
                    {/each}
                    {#if logs.length === 0}
                      <tr><td colspan="8" class="empty-cell">No requests in this range.</td></tr>
                    {/if}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

        {:else if activeTab === 'playground'}
          <div class="tab-pane">
            <div class="playground-layout">
              <div class="drawer-box">
                <div class="field">
                  <label for="pl-model">Combo</label>
                  <select id="pl-model" bind:value={playModel}>
                    {#each combos as combo}
                      <option value={combo.id}>{combo.displayName} ({combo.id})</option>
                    {/each}
                  </select>
                </div>
                <div class="field">
                  <label for="pl-sys">System Instruction (SOUL.md / AGENT.md style)</label>
                  <textarea id="pl-sys" rows="3" bind:value={playSystem} placeholder="You are a senior fullstack engineer..."></textarea>
                </div>
                <div class="field">
                  <label for="pl-prompt">Prompt</label>
                  <textarea id="pl-prompt" rows="5" bind:value={playPrompt}></textarea>
                </div>
                <div class="param-grid">
                  <div class="field">
                    <label for="pl-temp">Temp: {playTemp}</label>
                    <input id="pl-temp" type="range" min="0" max="2" step="0.1" bind:value={playTemp} />
                  </div>
                  <div class="field">
                    <label for="pl-max">Max Tokens</label>
                    <input id="pl-max" type="number" bind:value={playMaxTokens} />
                  </div>
                </div>
                <div class="checkbox-row">
                  <input type="checkbox" id="pl-stream" bind:checked={playStream} />
                  <label for="pl-stream">Stream (SSE)</label>
                </div>
                <button class="btn-brand" disabled={playRunning} onclick={handleRunPlayground}>
                  {playRunning ? "Running…" : "Send request"}
                </button>
              </div>

              <div class="terminal">
                <div class="term-head">
                  <span>Response</span>
                  {#if playMeta.latency}
                    <span class="term-meta">{playMeta.latency} ms · {fmtNum(playMeta.tokens)} tokens</span>
                  {/if}
                </div>
                <pre class="term-body">{playOutput || (playRunning ? "Streaming…" : "Awaiting request.")}</pre>
              </div>
            </div>
          </div>

        {:else if activeTab === 'oauth'}
          <div class="tab-pane">
            <div class="drawer-box wide-box">
              <div class="drawer-title">Import CLI session</div>
              <div class="field">
                <label for="oa-prov">Provider</label>
                <select id="oa-prov" bind:value={oauthProviderId}>
                  {#each providers as prov}
                    <option value={prov.id}>{prov.name} ({prov.id})</option>
                  {/each}
                </select>
              </div>
              <div class="field">
                <label for="oa-json">Session JSON</label>
                <textarea id="oa-json" rows="9" bind:value={oauthJson} placeholder={'{\n  "client_id": "…",\n  "refresh_token": "…",\n  "token_uri": "https://oauth2.googleapis.com/token"\n}'}></textarea>
              </div>
              <div class="action-row">
                <button class="btn-brand" onclick={handleImportOAuth}>Import</button>
                {#if oauthStatusMsg}<span class="status-inline">{oauthStatusMsg}</span>{/if}
              </div>
            </div>
          </div>
        {/if}

        {#if showImportModal}
          <div class="modal-backdrop" onclick={() => showImportModal = false} role="presentation">
            <div class="modal-card" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
              <div class="modal-header">
                <div class="modal-title">Import Configuration</div>
                <button class="modal-close" onclick={() => showImportModal = false} aria-label="Close">✕</button>
              </div>

              <div class="modal-body">
                <div class="bulk-help-banner">
                  Upload or paste an <strong>IsoRoute</strong> config JSON or a <strong>9Router</strong> backup JSON (<code>9router-backup-*.json</code>). Nodes, connections, and combos will be automatically mapped and pooled!
                </div>

                <div class="field">
                  <label for="import-file">Upload JSON File</label>
                  <input id="import-file" type="file" accept=".json,application/json" onchange={handleFileSelect} />
                </div>

                <div class="field">
                  <label for="import-paste">Or Paste Raw JSON</label>
                  <textarea
                    id="import-paste"
                    class="bulk-textarea"
                    bind:value={importRawJson}
                    placeholder={`{"providers": [...], "combos": [...]} or 9Router backup JSON`}
                    rows="6"
                  ></textarea>
                </div>

                <div class="field">
                  <label for="import-strat">Import Strategy</label>
                  <div id="import-strat" class="sub-mode-selector">
                    <button class="sub-mode-btn" class:active={importMode === 'merge'} onclick={() => importMode = 'merge'}>
                      Merge (Keep existing & add new)
                    </button>
                    <button class="sub-mode-btn" class:active={importMode === 'replace'} onclick={() => importMode = 'replace'}>
                      Replace All (Wipe & Restore)
                    </button>
                  </div>
                </div>

                {#if importResultMsg}
                  <div class="bulk-result-badge" class:badge-err={importResultMsg.startsWith('[Error]')}>
                    {importResultMsg}
                  </div>
                {/if}
              </div>

              <div class="modal-footer">
                <button class="btn-subtle" onclick={() => showImportModal = false}>Cancel</button>
                <button class="btn-brand" disabled={importLoading || !importRawJson.trim()} onclick={handleRunImport}>
                  {importLoading ? "Importing..." : "Run Import"}
                </button>
              </div>
            </div>
          </div>
        {/if}
      </main>
    </div>
  </div>
{/if}

<style>
  :global(:root) {
    --bg: #09090b;
    --surface: #111113;
    --surface-elevated: #18181b;
    --border: rgba(255, 255, 255, 0.08);
    --border-subtle: rgba(255, 255, 255, 0.04);
    --text: #ededed;
    --text-muted: #9ca3af;
    --text-dim: #6b7280;
    --accent: #e56a4a;
    --accent-hover: #cc5236;
    --accent-dim: rgba(229, 106, 74, 0.1);
    --font-mono: "JetBrains Mono", ui-monospace, monospace;
    --font-sans: "Inter", -apple-system, BlinkMacSystemFont, sans-serif;
  }

  /* Auth */
  .auth-gate {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
    box-sizing: border-box;
    overflow-x: hidden;
  }
  .auth-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 22px;
    width: 100%;
    max-width: 330px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    box-sizing: border-box;
  }
  .auth-head { display: flex; align-items: center; gap: 10px; }
  .auth-head h1 { font-size: 14px; font-weight: 600; }
  .auth-sub { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-dim); }
  .auth-form { display: flex; flex-direction: column; gap: 12px; }
  .auth-foot { border-top: 1px solid var(--border-subtle); padding-top: 10px; text-align: center; }
  .auth-foot a { font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); text-decoration: none; }
  .auth-foot a:hover { color: var(--accent); }

  .brand-mark {
    width: 26px;
    height: 26px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--surface-elevated);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--accent);
  }

  /* Layout */
  .app-layout {
    display: flex;
    min-height: 100vh;
    background: var(--bg);
    color: var(--text);
    font-family: var(--font-sans);
  }
  .sidebar {
    width: 210px;
    flex-shrink: 0;
    background: var(--surface);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
  }
  .sidebar-brand {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 14px 14px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .brand-titles { display: flex; flex-direction: column; line-height: 1.3; }
  .brand-name { font-size: 12.5px; font-weight: 600; }
  .brand-tag { font-family: var(--font-mono); font-size: 9.5px; color: var(--text-dim); }

  .sidebar-nav {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 10px 8px;
    overflow-y: auto;
  }
  .nav-item {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 9px;
    background: transparent;
    border: none;
    border-radius: 5px;
    color: var(--text-muted);
    font-family: var(--font-sans);
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }
  .nav-item:hover { background: rgba(255, 255, 255, 0.03); color: var(--text); }
  .nav-item.active { background: var(--surface-elevated); color: var(--text); }
  .nav-item.active :global(svg) { color: var(--accent); }
  .pill-count {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: 9.5px;
    color: var(--text-dim);
    font-variant-numeric: tabular-nums;
  }

  .sidebar-footer {
    border-top: 1px solid var(--border-subtle);
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .user-pill { padding: 0 2px; }
  .user-meta { display: flex; flex-direction: column; line-height: 1.35; }
  .u-name { font-size: 11.5px; }
  .u-host { font-family: var(--font-mono); font-size: 9.5px; color: var(--text-dim); }
  .footer-actions { display: flex; gap: 6px; }

  .workspace { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .topbar {
    height: 50px;
    padding: 0 18px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .topbar-title { font-size: 13px; font-weight: 600; }
  .topbar-actions { display: flex; align-items: center; gap: 8px; }

  .live-tag {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--accent);
    letter-spacing: 0.04em;
  }
  .live-bar {
    width: 14px;
    height: 2px;
    background: var(--accent);
    animation: sweep 900ms ease-in-out infinite alternate;
  }
  @keyframes sweep { from { transform: scaleX(0.3); opacity: 0.5; } to { transform: scaleX(1); opacity: 1; } }

  .content-body { flex: 1; padding: 18px; overflow-y: auto; }
  .tab-pane { display: flex; flex-direction: column; gap: 14px; max-width: 1080px; }

  /* Metrics */
  .metrics-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .metric-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 12px 14px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .met-label {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .met-val {
    font-family: var(--font-mono);
    font-size: 19px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  /* Toolbar */
  .toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: space-between;
  }
  .seg {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 5px;
    overflow: hidden;
  }
  .seg-btn {
    background: transparent;
    border: none;
    border-right: 1px solid var(--border);
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10.5px;
    padding: 5px 11px;
    cursor: pointer;
  }
  .seg-btn:last-child { border-right: none; }
  .seg-btn:hover { color: var(--text); }
  .seg-btn.on { background: var(--surface-elevated); color: var(--accent); }

  .sort-controls { display: flex; align-items: center; gap: 6px; }
  .sort-controls select {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10.5px;
    padding: 5px 8px;
  }

  .custom-range {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .custom-range input {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 10.5px;
    padding: 5px 8px;
  }
  .range-sep { color: var(--text-dim); font-family: var(--font-mono); font-size: 11px; }

  .notice {
    border: 1px solid var(--border);
    border-left: 2px solid var(--accent);
    background: var(--surface);
    border-radius: 4px;
    padding: 9px 12px;
    font-size: 11.5px;
    color: var(--text-muted);
    line-height: 1.5;
  }

  /* Sections */
  .section-box {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 5px;
    overflow: hidden;
  }
  .box-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 9px 12px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .box-title { font-size: 12px; font-weight: 600; }
  .box-meta { font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); }

  /* Activity strip */
  .activity-strip {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 40px;
    padding: 6px 12px 8px;
  }
  .act-bar {
    flex: 1;
    min-width: 2px;
    background: rgba(255, 255, 255, 0.07);
    border-radius: 1px;
    transition: background 120ms linear;
  }
  .act-bar.on { background: var(--accent); }

  /* Routes */
  .route-list { display: flex; flex-direction: column; }
  .route-line {
    display: grid;
    grid-template-columns: 130px 1fr auto;
    gap: 10px;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-subtle);
    font-family: var(--font-mono);
    font-size: 11px;
    border-left: 2px solid transparent;
  }
  .route-line:last-child { border-bottom: none; }
  .route-line.flowing { border-left-color: var(--accent); }
  .route-slug { color: var(--text); font-weight: 500; }
  .route-line.flowing .route-slug { color: var(--accent); }
  .route-chain { color: var(--text-dim); word-break: break-all; }
  .route-load { color: var(--accent); font-variant-numeric: tabular-nums; }
  .route-load.zero { color: var(--text-dim); }

  /* Tables */
  .table-container { overflow-x: auto; max-height: 520px; }
  .dense-table { width: 100%; border-collapse: collapse; font-size: 11.5px; text-align: left; }
  .dense-table th {
    position: sticky;
    top: 0;
    background: var(--surface-elevated);
    padding: 8px 11px;
    font-family: var(--font-mono);
    font-size: 9.5px;
    font-weight: 500;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  .dense-table td { padding: 8px 11px; border-bottom: 1px solid var(--border-subtle); }
  .mono { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .mono.strong { color: var(--text); font-weight: 500; }
  .mono.dim { color: var(--text-dim); font-size: 10.5px; }

  .status-badge {
    display: inline-block;
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    padding: 1px 6px;
    border-radius: 3px;
  }
  .s-ok { background: rgba(34, 197, 94, 0.12); color: #22c55e; }
  .s-warn { background: rgba(245, 158, 11, 0.13); color: #f59e0b; }
  .s-err { background: rgba(239, 68, 68, 0.13); color: #ef4444; }

  .empty-cell {
    text-align: center;
    padding: 20px;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  /* Mobile feed */
  .mobile-feed { display: none; flex-direction: column; }
  .feed-item { display: flex; flex-direction: column; gap: 3px; padding: 9px 12px; border-bottom: 1px solid var(--border-subtle); }
  .feed-item:last-child { border-bottom: none; }
  .feed-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .feed-model { font-family: var(--font-mono); font-size: 11.5px; font-weight: 600; color: var(--accent); }
  .feed-target { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-dim); word-break: break-all; }
  .feed-meta { display: flex; flex-wrap: wrap; gap: 5px; font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); font-variant-numeric: tabular-nums; }

  /* Split layouts */
  .split-layout { display: grid; grid-template-columns: 1.25fr 1fr; gap: 14px; align-items: start; }
  .card-list { display: flex; flex-direction: column; gap: 9px; }

  /* Search bar */
  .search-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    background: #09090b;
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 6px 10px;
    margin-bottom: 3px;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .search-input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 11px;
    outline: none;
    padding: 2px 0;
  }
  .search-input::placeholder {
    color: var(--text-dim);
  }
  .search-clear {
    background: transparent;
    border: none;
    color: var(--text-dim);
    font-size: 11px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }
  .search-clear:hover {
    color: var(--text);
  }
  .search-count {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-dim);
    white-space: nowrap;
    user-select: none;
    font-variant-numeric: tabular-nums;
  }

  .item-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 9px;
  }
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .title-group { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
  .item-name { font-size: 12.5px; font-weight: 500; }
  .item-slug { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-dim); }
  .item-slug.accent { color: var(--accent); font-weight: 600; font-size: 12px; }
  .type-chip {
    font-family: var(--font-mono);
    font-size: 9.5px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-dim);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 1px 5px;
  }

  .detail-row { display: flex; align-items: baseline; gap: 8px; font-size: 11px; }
  .d-label { font-family: var(--font-mono); font-size: 10px; color: var(--text-dim); min-width: 64px; text-transform: uppercase; letter-spacing: 0.04em; }
  .d-val { font-family: var(--font-mono); color: var(--text-muted); font-size: 11px; word-break: break-all; }

  .ladder { display: flex; flex-direction: column; gap: 4px; background: #0b0b0d; border: 1px solid var(--border-subtle); border-radius: 4px; padding: 7px 9px; }
  .ladder-step { display: flex; align-items: center; gap: 7px; font-family: var(--font-mono); font-size: 10.5px; }
  .step-idx { color: var(--text-dim); }
  .step-prov { color: var(--text-muted); }
  .step-arr { color: var(--text-dim); }
  .step-model { color: var(--text); }
  .step-prio { margin-left: auto; color: var(--text-dim); font-size: 9.5px; }

  /* Drawer forms */
  .drawer-box {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 11px;
    height: fit-content;
  }
  .wide-box { max-width: 640px; }
  .drawer-title { font-size: 12px; font-weight: 600; padding-bottom: 8px; border-bottom: 1px solid var(--border-subtle); }
  .drawer-collapsible-body {
    display: flex;
    flex-direction: column;
    gap: 11px;
    width: 100%;
  }
  .drawer-title-group {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .drawer-mobile-btn {
    display: none;
    font-family: var(--font-mono);
    font-size: 10.5px;
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--border);
    color: var(--accent);
    cursor: pointer;
    line-height: 1.4;
  }
  .drawer-mobile-btn:hover {
    background: rgba(255, 255, 255, 0.1);
  }
  .drawer-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .drawer-header-row .drawer-title { padding-bottom: 0; border-bottom: none; }
  .subtab-group {
    display: flex;
    gap: 4px;
    background: rgba(255, 255, 255, 0.03);
    padding: 2px;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
  }
  .subtab-btn {
    background: transparent;
    border: none;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
  }
  .subtab-btn.active {
    background: rgba(255, 255, 255, 0.08);
    color: var(--text);
  }
  .sub-mode-selector {
    display: flex;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 2px;
    gap: 2px;
  }
  .sub-mode-btn {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text-dim);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 500;
    padding: 5px 8px;
    border-radius: 3px;
    cursor: pointer;
    text-align: center;
  }
  .sub-mode-btn.active {
    background: rgba(255, 255, 255, 0.08);
    color: var(--text);
  }
  .target-info-card {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    padding: 8px 10px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-muted);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .label-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .keys-detected-tag {
    font-family: var(--font-mono);
    font-size: 9.5px;
    color: var(--accent);
    letter-spacing: 0.02em;
    font-variant-numeric: tabular-nums;
  }
  .bulk-help-banner {
    background: rgba(255, 255, 255, 0.02);
    border: 1px dashed var(--border-subtle);
    border-radius: 4px;
    padding: 8px 10px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--text-muted);
    line-height: 1.4;
  }
  .bulk-help-banner code {
    color: var(--accent);
  }
  .bulk-textarea {
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.45;
    white-space: pre;
    resize: vertical;
  }
  .bulk-result-badge {
    margin-top: 6px;
    padding: 6px 10px;
    background: rgba(34, 197, 94, 0.08);
    border: 1px solid rgba(34, 197, 94, 0.2);
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: #4ade80;
    font-variant-numeric: tabular-nums;
  }
  .badge-err {
    background: rgba(239, 68, 68, 0.08) !important;
    border-color: rgba(239, 68, 68, 0.25) !important;
    color: #ef4444 !important;
  }

  .field { display: flex; flex-direction: column; gap: 4px; }
  .field label {
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .hint { color: var(--accent); text-transform: none; letter-spacing: 0; margin-left: 4px; }
  .field input,
  .field select,
  .field textarea {
    background: #0b0b0d;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: 11.5px;
    padding: 7px 9px;
    outline: none;
    box-sizing: border-box;
    width: 100%;
  }
  .field input:focus,
  .field select:focus,
  .field textarea:focus { border-color: var(--accent); }
  .field textarea { resize: vertical; }
  .checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--text-muted); }
  .action-row { display: flex; align-items: center; gap: 12px; }
  .status-inline { font-family: var(--font-mono); font-size: 11px; color: var(--accent); }
  .err-box {
    font-family: var(--font-mono);
    font-size: 11px;
    color: #ef4444;
    background: rgba(239, 68, 68, 0.08);
    border: 1px solid rgba(239, 68, 68, 0.2);
    border-radius: 4px;
    padding: 7px 9px;
  }

  /* Buttons */
  .btn-brand {
    background: var(--accent);
    color: #0b0b0d;
    border: none;
    border-radius: 4px;
    padding: 7px 14px;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }
  .btn-brand:hover { background: var(--accent-hover); }
  .btn-brand:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-brand.wide { width: 100%; }
  .btn-subtle {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 10.5px;
    padding: 4px 9px;
    cursor: pointer;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
  }
  .btn-subtle:hover { color: var(--text); border-color: rgba(255, 255, 255, 0.18); }
  .btn-icon {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-muted);
    padding: 4px 6px;
    cursor: pointer;
    display: inline-flex;
  }
  .btn-icon:hover { color: var(--text); }
  .btn-danger {
    background: transparent;
    border: 1px solid rgba(239, 68, 68, 0.25);
    border-radius: 3px;
    color: #ef4444;
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 2px 7px;
    cursor: pointer;
  }
  .btn-danger:hover { background: rgba(239, 68, 68, 0.08); }

  /* Playground */
  .playground-layout { display: grid; grid-template-columns: 1fr 1.2fr; gap: 14px; align-items: start; }
  .terminal { background: var(--surface); border: 1px solid var(--border); border-radius: 5px; overflow: hidden; display: flex; flex-direction: column; }
  .term-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 9px 12px;
    border-bottom: 1px solid var(--border-subtle);
    font-family: var(--font-mono);
    font-size: 10px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .term-meta { color: var(--accent); text-transform: none; letter-spacing: 0; }
  .term-body {
    margin: 0;
    padding: 12px;
    background: #0b0b0d;
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 1.55;
    color: #d4d4d8;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 460px;
    overflow-y: auto;
  }

  /* Modal Backdrop & Card */
  .modal-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 999;
    padding: 16px;
  }
  .modal-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    width: 100%;
    max-width: 520px;
    display: flex;
    flex-direction: column;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    animation: modalIn 150ms ease-out;
  }
  @keyframes modalIn {
    from { opacity: 0; transform: scale(0.97); }
    to { opacity: 1; transform: scale(1); }
  }
  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .modal-title { font-size: 13px; font-weight: 600; font-family: var(--font-mono); }
  .modal-close {
    background: transparent;
    border: none;
    color: var(--text-dim);
    font-size: 14px;
    cursor: pointer;
    padding: 2px 6px;
  }
  .modal-close:hover { color: var(--text); }
  .modal-body {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 75vh;
    overflow-y: auto;
  }
  .modal-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 16px;
    border-top: 1px solid var(--border-subtle);
    background: rgba(255, 255, 255, 0.01);
  }

  .desktop-only { display: block; }
  .mobile-only { display: none !important; }
  .mobile-action { display: none; }

  @media (max-width: 880px) {
    .app-layout { flex-direction: column; }
    .sidebar { width: 100%; border-right: none; border-bottom: 1px solid var(--border); }
    .sidebar-brand { padding: 10px 12px; }
    .sidebar-nav {
      flex-direction: row;
      gap: 4px;
      padding: 6px 10px;
      overflow-x: auto;
      scrollbar-width: none;
      border-top: 1px solid var(--border-subtle);
    }
    .sidebar-nav::-webkit-scrollbar { display: none; }
    .nav-item { padding: 5px 9px; font-size: 11.5px; white-space: nowrap; flex-shrink: 0; }
    .nav-item span:not(.pill-count) { display: inline; }
    .sidebar-footer { display: none; }
    .mobile-action { display: inline-flex; }

    .topbar { height: 44px; padding: 0 12px; }
    .content-body { padding: 12px; }
    .metrics-row { grid-template-columns: 1fr 1fr; gap: 8px; }
    .metric-card { padding: 10px 12px; }
    .met-val { font-size: 16px; }

    .desktop-only { display: none !important; }
    .mobile-only { display: flex !important; }

    .split-layout {
      display: flex;
      flex-direction: column;
    }
    .playground-layout { grid-template-columns: 1fr; }
    .drawer-box {
      order: -1;
      width: 100%;
      margin-bottom: 12px;
      padding: 10px 12px;
    }
    .drawer-mobile-btn {
      display: inline-flex !important;
    }
    .drawer-box:not(.mobile-open) {
      padding: 8px 12px;
    }
    .drawer-box:not(.mobile-open) .drawer-header-row {
      border-bottom: none;
      padding-bottom: 0;
    }
    .drawer-box:not(.mobile-open) .drawer-collapsible-body {
      display: none !important;
    }

    .route-line { grid-template-columns: 1fr; gap: 3px; }
    .route-load { justify-self: start; }
    .toolbar { gap: 8px; }
    .seg-btn { padding: 5px 9px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .live-bar, .act-bar { animation: none; transition: none; }
  }

  .probe-box {
    padding: 7px 10px;
    border-radius: 4px;
    font-family: var(--font-mono);
    font-size: 10.5px;
  }
  .probe-ok { background: rgba(34, 197, 94, 0.1); border: 1px solid rgba(34, 197, 94, 0.25); color: #22c55e; }
  .probe-err { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.25); color: #ef4444; }
  .param-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .selectable { user-select: all; }
  .text-white { color: var(--text); }

</style>
