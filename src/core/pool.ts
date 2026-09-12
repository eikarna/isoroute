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

  /**
   * Extract all keys from a provider (comma-separated or single)
   */
  static extractKeys(provider: Provider): string[] {
    if (!provider.apiKey) return [];
    return provider.apiKey
      .split(/[\n,]/)
      .map((k) => k.trim())
      .filter(Boolean);
  }

  /**
   * Select next healthy key via Round-Robin with Circuit-Breaker awareness
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

    // If all keys are in cooldown, pick the one that expires soonest
    const candidatePool = healthyKeys.length > 0 ? healthyKeys : keys;

    // Round-robin selection
    const currentIndex = this.rrIndexes.get(provider.id) ?? 0;
    const nextIndex = (currentIndex + 1) % candidatePool.length;
    this.rrIndexes.set(provider.id, nextIndex);

    const selected = candidatePool[nextIndex];
    const status = this.getOrCreateStatus(selected);
    status.lastUsed = now;

    return selected;
  }

  /**
   * Trip the circuit breaker for this key (e.g. on HTTP 429 or 503)
   */
  static markCooldown(key: string, cooldownDurationMs = 180000): void {
    const status = this.getOrCreateStatus(key);
    status.failureCount += 1;
    status.cooldownUntil = Date.now() + cooldownDurationMs;
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
