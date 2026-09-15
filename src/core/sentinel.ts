// Self-Healing Sentinel for Background Health Probing & Cooldown Recovery
import type { StorageAdapter } from "../storage";
import type { Provider } from "../types";
import { KeyPoolManager } from "./pool";

export class SentinelEngine {
  /**
   * Ping provider endpoint with a 1-token probe request to test if cooldown/rate-limit has elapsed
   */
  static async probeKey(provider: Provider, key: string): Promise<boolean> {
    const timeoutMs = 5000;
    try {
      if (provider.type === "gemini") {
        const url = `${provider.baseUrl.replace(/\/+$/, "")}/v1beta/models/gemini-2.5-flash:generateContent`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "p" }] }] }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return res.ok;
      } else if (provider.type === "anthropic") {
        const url = `${provider.baseUrl.replace(/\/+$/, "")}/v1/messages`;
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-3-haiku-20240307",
            max_tokens: 1,
            messages: [{ role: "user", content: "p" }],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return res.ok;
      } else {
        // OpenAI-compatible
        const url = `${provider.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            max_tokens: 1,
            messages: [{ role: "user", content: "p" }],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return res.ok;
      }
    } catch {
      return false;
    }
  }

  /**
   * Run background health scan over keys currently locked in cooldown
   */
  static async runSentinel(storage: StorageAdapter): Promise<{ checked: number; recovered: number }> {
    const cooldownKeys = KeyPoolManager.getCooldownKeys();
    if (cooldownKeys.length === 0) return { checked: 0, recovered: 0 };

    console.log(`[Sentinel] Health check started. Probing ${cooldownKeys.length} locked key(s)...`);
    const providers = await storage.getProviders();
    let recovered = 0;

    for (const key of cooldownKeys) {
      const owner = providers.find((p) => p.apiKey && p.apiKey.includes(key));
      if (!owner || !owner.enabled) continue;

      const isHealthy = await this.probeKey(owner, key);
      if (isHealthy) {
        KeyPoolManager.clearCooldown(key);
        recovered++;
        console.log(`[Sentinel] Key '...${key.slice(-4)}' recovered and restored to active pool.`);
      }
    }

    console.log(`[Sentinel] Health check finished. Checked: ${cooldownKeys.length}, Recovered: ${recovered}`);
    return { checked: cooldownKeys.length, recovered };
  }
}
