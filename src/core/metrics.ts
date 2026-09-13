import type { TargetRoute, ComboStrategy } from "../types";

export interface TargetMetric {
  samples: number;
  avgLatencyMs: number;
  avgTtftMs: number;
  lastUpdated: number;
}

export class MetricsEngine {
  private static metrics = new Map<string, TargetMetric>();
  private static rrIndexes = new Map<string, number>();

  private static getTargetKey(providerId: string, model: string): string {
    return `${providerId}::${model}`;
  }

  /**
   * Record a completed request telemetry for a target
   */
  static record(
    providerId: string,
    model: string,
    totalLatencyMs: number,
    ttftMs?: number
  ): void {
    const key = this.getTargetKey(providerId, model);
    const existing = this.metrics.get(key);
    const now = Date.now();
    const effectiveTtft = ttftMs && ttftMs > 0 ? ttftMs : totalLatencyMs;

    if (!existing) {
      this.metrics.set(key, {
        samples: 1,
        avgLatencyMs: totalLatencyMs,
        avgTtftMs: effectiveTtft,
        lastUpdated: now,
      });
      return;
    }

    // Exponential Moving Average (EMA) with alpha = 0.35 for responsive adaptation
    const alpha = 0.35;
    const newLatency = Math.round(existing.avgLatencyMs * (1 - alpha) + totalLatencyMs * alpha);
    const newTtft = Math.round(existing.avgTtftMs * (1 - alpha) + effectiveTtft * alpha);

    existing.samples += 1;
    existing.avgLatencyMs = newLatency;
    existing.avgTtftMs = newTtft;
    existing.lastUpdated = now;
  }

  /**
   * Get recorded metric for target
   */
  static get(providerId: string, model: string): TargetMetric | undefined {
    return this.metrics.get(this.getTargetKey(providerId, model));
  }

  /**
   * Sort targets based on the selected combo strategy
   */
  static sortTargets(
    targets: TargetRoute[],
    strategy: ComboStrategy = "fallback",
    comboId?: string
  ): TargetRoute[] {
    if (targets.length <= 1) return [...targets];

    switch (strategy) {
      case "round-robin": {
        const id = comboId || "default";
        const currentIdx = this.rrIndexes.get(id) ?? 0;
        const nextIdx = (currentIdx + 1) % targets.length;
        this.rrIndexes.set(id, nextIdx);

        // Rotate the array so the chosen candidate is first, followed by the rest as fallbacks
        return [...targets.slice(nextIdx), ...targets.slice(0, nextIdx)];
      }

      case "latency-first": {
        return [...targets].sort((a, b) => {
          const mA = this.get(a.providerId, a.model);
          const mB = this.get(b.providerId, b.model);

          // If both have metrics, sort lowest total latency first
          if (mA && mB) {
            return mA.avgLatencyMs - mB.avgLatencyMs;
          }
          // If only one has metric, prioritize measured one unless it was slow (> 10s)
          if (mA && !mB) return mA.avgLatencyMs < 10000 ? -1 : 1;
          if (!mA && mB) return mB.avgLatencyMs < 10000 ? 1 : -1;

          // Default fallback to configured priority
          return (b.priority || 0) - (a.priority || 0);
        });
      }

      case "ttft-first": {
        return [...targets].sort((a, b) => {
          const mA = this.get(a.providerId, a.model);
          const mB = this.get(b.providerId, b.model);

          // If both have metrics, sort lowest Time To First Token first
          if (mA && mB) {
            return mA.avgTtftMs - mB.avgTtftMs;
          }
          if (mA && !mB) return mA.avgTtftMs < 6000 ? -1 : 1;
          if (!mA && mB) return mB.avgTtftMs < 6000 ? 1 : -1;

          // Default fallback to configured priority
          return (b.priority || 0) - (a.priority || 0);
        });
      }

      case "fallback":
      default: {
        // Strict priority-based descending order
        return [...targets].sort((a, b) => (b.priority || 0) - (a.priority || 0));
      }
    }
  }

  /**
   * Reset metrics (useful for testing)
   */
  static reset(): void {
    this.metrics.clear();
    this.rrIndexes.clear();
  }
}
