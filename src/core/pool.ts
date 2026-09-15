// Multi-Key Pool & Smart Circuit Breaker (Cooldown on 429 / 503)
import type { Provider } from "../types";

export interface KeyStatus {
  key: string;
  cooldownUntil: number;
  failureCount: number;
  successCount: number;
  lastUsed: number;
  inFlight: number;
  inFlightResetAt?: number;
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
   * Query current in-flight concurrent request count for a key (with auto-decay safety)
   */
  static getInFlight(key: string): number {
    const status = this.poolState.get(key);
    if (!status) return 0;
    if (status.inFlight > 0 && status.inFlightResetAt && Date.now() > status.inFlightResetAt) {
      status.inFlight = 0;
    }
    return status.inFlight;
  }

  /**
   * Acquire a key for an in-flight request, returning an idempotent release function
   */
  static acquireKey(key: string): () => void {
    const status = this.getOrCreateStatus(key);
    status.inFlight += 1;
    status.inFlightResetAt = Date.now() + 60000; // 60s auto-decay TTL
    let released = false;
    return () => {
      if (!released) {
        released = true;
        status.inFlight = Math.max(0, status.inFlight - 1);
      }
    };
  }

  /**
   * Select next healthy key via configured strategy:
   * - "fallback": always uses the primary (first) healthy key until it hits error/cooldown.
   * - "round-robin": rotates keys every `stickyCount` requests.
   * - "least-connections": dynamically routes to the key with fewest in-flight requests.
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

    if (strategy === "least-connections") {
      let bestKey = candidatePool[0];
      let minInFlight = this.getInFlight(bestKey);
      for (let i = 1; i < candidatePool.length; i++) {
        const k = candidatePool[i];
        const inflight = this.getInFlight(k);
        if (inflight < minInFlight) {
          bestKey = k;
          minInFlight = inflight;
        }
      }
      const status = this.getOrCreateStatus(bestKey);
      status.lastUsed = now;
      return bestKey;
    }

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

  /**
   * Return all keys currently locked in cooldown
   */
  static getCooldownKeys(): string[] {
    const now = Date.now();
    const result: string[] = [];
    for (const [key, status] of this.poolState.entries()) {
      if (status.cooldownUntil > now) {
        result.push(key);
      }
    }
    return result;
  }

  /**
   * Manually or automatically clear cooldown for a key (e.g. after Sentinel verification)
   */
  static clearCooldown(key: string): void {
    const status = this.poolState.get(key);
    if (status) {
      status.cooldownUntil = 0;
      status.failureCount = 0;
      console.log(`[CircuitBreaker] Cooldown cleared for key '...${key.slice(-4)}'`);
    }
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
        inFlight: 0,
      };
      this.poolState.set(key, status);
    }
    return status;
  }
}
