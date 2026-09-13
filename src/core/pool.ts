// Multi-Key Pool & Smart Circuit Breaker (Cooldown on 429 / 503)
import type { Provider } from "../types";

export interface KeyStatus {
  key: string;
  cooldownUntil: number;
  failureCount: number;
  successCount: number;
  lastUsed: number;
}

export class KeyPoolManager {
  private static poolState = new Map<string, KeyStatus>();
  private static rrIndexes = new Map<string, number>();
  private static rrUsageCounts = new Map<string, number>();

  /**
   * Extract all keys from a provider (comma-separated or newline-separated)
   */
  static extractKeys(provider: Provider): string[] {
    if (!provider.apiKey) return [];
    return provider.apiKey
      .split(/[\n,]/)
      .map((k) => k.trim())
      .filter(Boolean);
  }

  /**
   * Select next healthy key via configured strategy:
   * - "fallback": always uses the primary (first) healthy key until it hits error/cooldown.
   * - "round-robin": rotates keys every `stickyCount` requests.
   */
  static selectKey(provider: Provider): string | undefined {
    const keys = this.extractKeys(provider);
    if (keys.length === 0) return undefined;
    if (keys.length === 1) return keys[0];

    const now = Date.now();
    const healthyKeys: string[] = [];

    for (const key of keys) {
      const status = this.poolState.get(key);
      if (!status || status.cooldownUntil <= now) {
        healthyKeys.push(key);
      }
    }

    // If all keys are in cooldown, pick the full pool as last resort
    const candidatePool = healthyKeys.length > 0 ? healthyKeys : keys;
    const strategy = provider.keyStrategy || "fallback";
    const stickyCount = Math.max(1, provider.stickyCount || 1);

    if (strategy === "fallback") {
      const selected = candidatePool[0];
      const status = this.getOrCreateStatus(selected);
      status.lastUsed = now;
      return selected;
    }

    // Round-robin with stickyCount
    let currentIndex = this.rrIndexes.get(provider.id) ?? 0;
    let currentUsage = this.rrUsageCounts.get(provider.id) ?? 0;

    if (currentIndex >= candidatePool.length) {
      currentIndex = 0;
      currentUsage = 0;
    }

    if (currentUsage >= stickyCount) {
      currentIndex = (currentIndex + 1) % candidatePool.length;
      currentUsage = 0;
    }

    this.rrIndexes.set(provider.id, currentIndex);
    this.rrUsageCounts.set(provider.id, currentUsage + 1);

    const selected = candidatePool[currentIndex];
    const status = this.getOrCreateStatus(selected);
    status.lastUsed = now;

    return selected;
  }

  /**
   * Trip the circuit breaker for this key (e.g. on HTTP 401, 403, 429, 503)
   */
  static markCooldown(key: string, cooldownDurationMs = 180000): void {
    const status = this.getOrCreateStatus(key);
    status.failureCount += 1;
    status.cooldownUntil = Date.now() + cooldownDurationMs;

    // Reset sticky counter so any provider using round-robin rotates immediately away from this key
    for (const providerId of this.rrIndexes.keys()) {
      this.rrUsageCounts.set(providerId, 999999);
    }

    console.warn(`[CircuitBreaker] Key '...${key.slice(-4)}' locked for ${Math.round(cooldownDurationMs / 1000)}s`);
  }

  /**
   * Record successful request on key
   */
  static markSuccess(key: string): void {
    const status = this.getOrCreateStatus(key);
    status.successCount += 1;
    status.failureCount = Math.max(0, status.failureCount - 1);
  }

  static reset(): void {
    this.poolState.clear();
    this.rrIndexes.clear();
    this.rrUsageCounts.clear();
  }

  private static getOrCreateStatus(key: string): KeyStatus {
    let status = this.poolState.get(key);
    if (!status) {
      status = {
        key,
        cooldownUntil: 0,
        failureCount: 0,
        successCount: 0,
        lastUsed: 0,
      };
      this.poolState.set(key, status);
    }
    return status;
  }
}
