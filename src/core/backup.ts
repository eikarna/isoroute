// Full Config Backup & Migration Engine for IsoRoute
// Supports native IsoRoute export/import AND direct auto-migration from 9Router backup JSON

import type { Provider, ModelCombo } from "../types";
import type { RouteRule } from "./rewrite";
import type { ApiKeyRecord } from "./keys";
import type { StorageAdapter } from "../storage";
import { BulkIngestEngine } from "./bulk";

export interface IsoRouteBackup {
  version: "1.0";
  generator: "IsoRoute";
  exportedAt: string;
  providers: Provider[];
  combos: ModelCombo[];
  rules?: RouteRule[];
  apiKeys?: ApiKeyRecord[];
}

export interface ImportResult {
  success: boolean;
  format: "isoroute" | "9router" | "unknown";
  mode: "merge" | "replace";
  stats: {
    providersSaved: number;
    combosSaved: number;
    rulesSaved: number;
    keysSaved: number;
    connectionsPooled?: number;
  };
  durationMs: number;
}

export class BackupEngine {
  /**
   * Export all configuration from storage into a standardized IsoRoute JSON document
   */
  static async exportConfig(storage: StorageAdapter): Promise<IsoRouteBackup> {
    const providers = await storage.getProviders();
    const combos = await storage.getCombos();
    const rules = await storage.getRules();
    const apiKeys = await storage.getKeys();

    return {
      version: "1.0",
      generator: "IsoRoute",
      exportedAt: new Date().toISOString(),
      providers,
      combos,
      rules,
      apiKeys,
    };
  }

  /**
   * Detect whether a given JSON object is a 9Router backup document
   */
  static is9RouterBackup(data: any): boolean {
    if (!data || typeof data !== "object") return false;
    return Boolean(
      data.providerNodes ||
      data.providerConnections ||
      (Array.isArray(data.combos) && data.combos[0] && Array.isArray(data.combos[0].models))
    );
  }

  /**
   * Convert 9Router JSON backup structure into IsoRoute's native Provider and ModelCombo models
   */
  static convert9RouterToIsoRoute(data: any): { providers: Provider[]; combos: ModelCombo[]; pooledConnections: number } {
    const nodeMap = new Map<string, { id: string; name: string; baseUrl: string; prefix: string; type: string }>();

    // 1. Process providerNodes
    if (Array.isArray(data.providerNodes)) {
      for (const node of data.providerNodes) {
        let nodeData: any = {};
        if (typeof node.data === "string") {
          try { nodeData = JSON.parse(node.data); } catch {}
        } else if (typeof node.data === "object") {
          nodeData = node.data;
        }

        const prefix = nodeData.prefix || node.prefix || node.name?.toLowerCase().replace(/[^a-z0-9]/g, "");
        const baseUrl = nodeData.baseUrl || node.baseUrl || "";
        const id = prefix || node.id;
        const name = node.name || prefix;

        if (id) {
          nodeMap.set(id, { id, name, baseUrl, prefix: prefix || id, type: "openai" });
          if (node.id) nodeMap.set(node.id, { id, name, baseUrl, prefix: prefix || id, type: "openai" });
        }
      }
    }

    // Default known standard 9Router providers
    const standardProviders: Record<string, { name: string; baseUrl: string; type: "openai" | "gemini" | "anthropic" }> = {
      "nvidia": { name: "Nvidia NIM", baseUrl: "https://integrate.api.nvidia.com/v1", type: "openai" },
      "openrouter": { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", type: "openai" },
      "gemini": { name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com", type: "gemini" },
      "tokenrouter": { name: "TokenRouter", baseUrl: "https://tokenrouter.ai/v1", type: "openai" },
      "bazaarlink": { name: "BazaarLink", baseUrl: "https://api.bazaarlink.ai/v1", type: "openai" },
      "venice": { name: "Venice AI", baseUrl: "https://api.venice.ai/api/v1", type: "openai" },
      "cloudflare-ai": { name: "Cloudflare Workers AI", baseUrl: "https://api.cloudflare.com/client/v4/accounts", type: "openai" },
      "groq": { name: "Groq Cloud", baseUrl: "https://api.groq.com/openai/v1", type: "openai" },
      "cerebras": { name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", type: "openai" },
    };

    // 2. Pool providerConnections keys by target provider
    const keysByProvider = new Map<string, Set<string>>();
    let pooledConnections = 0;

    if (Array.isArray(data.providerConnections)) {
      for (const conn of data.providerConnections) {
        let connData: any = {};
        if (typeof conn.data === "string") {
          try { connData = JSON.parse(conn.data); } catch {}
        } else if (typeof conn.data === "object") {
          connData = conn.data;
        }

        const rawKey = connData.apiKey || conn.apiKey;
        const providerTarget = conn.provider;
        if (!providerTarget) continue;

        // Resolve target provider ID (either node prefix or standard provider ID)
        let resolvedId = providerTarget;
        if (nodeMap.has(providerTarget)) {
          resolvedId = nodeMap.get(providerTarget)!.id;
        }

        if (rawKey && typeof rawKey === "string" && rawKey.trim()) {
          if (!keysByProvider.has(resolvedId)) {
            keysByProvider.set(resolvedId, new Set());
          }
          keysByProvider.get(resolvedId)!.add(rawKey.trim());
          pooledConnections++;
        }
      }
    }

    // 3. Assemble IsoRoute Providers
    const providersMap = new Map<string, Provider>();

    // From nodeMap
    for (const [key, node] of nodeMap.entries()) {
      if (providersMap.has(node.id)) continue;
      const keySet = keysByProvider.get(node.id) || keysByProvider.get(key);
      const pooledKeys = keySet ? Array.from(keySet).join(",") : "";
      providersMap.set(node.id, {
        id: node.id,
        name: node.name,
        baseUrl: node.baseUrl || "https://api.openai.com/v1",
        apiKey: pooledKeys,
        type: (node.type as any) || "openai",
        enabled: true,
      });
    }

    // From standard providers with connections
    for (const [provId, keys] of keysByProvider.entries()) {
      if (!providersMap.has(provId)) {
        const std = standardProviders[provId];
        providersMap.set(provId, {
          id: provId,
          name: std ? std.name : provId,
          baseUrl: std ? std.baseUrl : "https://api.openai.com/v1",
          apiKey: Array.from(keys).join(","),
          type: std ? std.type : "openai",
          enabled: true,
        });
      }
    }

    // 4. Process Combos
    const combos: ModelCombo[] = [];
    if (Array.isArray(data.combos)) {
      for (const c of data.combos) {
        let models: string[] = [];
        if (Array.isArray(c.models)) {
          models = c.models;
        } else if (typeof c.models === "string") {
          try { models = JSON.parse(c.models); } catch {}
        }

        const id = c.name || c.id;
        const displayName = c.name || c.id;
        const targets = models.map((mStr, idx) => {
          const parts = mStr.split("/");
          const prefix = parts[0];
          const modelPath = parts.slice(1).join("/") || prefix;
          return {
            providerId: prefix,
            model: modelPath,
            priority: idx,
          };
        });

        combos.push({
          id,
          displayName,
          targets,
        });
      }
    }

    return {
      providers: Array.from(providersMap.values()),
      combos,
      pooledConnections,
    };
  }

  /**
   * Import config (native IsoRoute or 9Router backup) into storage
   */
  static async importConfig(
    storage: StorageAdapter,
    rawPayload: any,
    mode: "merge" | "replace" = "merge"
  ): Promise<ImportResult> {
    const start = Date.now();
    let data = rawPayload;
    if (typeof rawPayload === "string") {
      try {
        data = JSON.parse(rawPayload);
      } catch (err) {
        throw new Error("Invalid JSON: Unable to parse import payload");
      }
    }

    const is9R = this.is9RouterBackup(data);
    let providersToSave: Provider[] = [];
    let combosToSave: ModelCombo[] = [];
    let rulesToSave: RouteRule[] = [];
    let keysToSave: ApiKeyRecord[] = [];
    let pooledConns = 0;

    if (is9R) {
      const converted = this.convert9RouterToIsoRoute(data);
      providersToSave = converted.providers;
      combosToSave = converted.combos;
      pooledConns = converted.pooledConnections;
    } else {
      if (Array.isArray(data.providers)) providersToSave = data.providers;
      if (Array.isArray(data.combos)) combosToSave = data.combos;
      if (Array.isArray(data.rules)) rulesToSave = data.rules;
      if (Array.isArray(data.apiKeys)) keysToSave = data.apiKeys;
    }

    // If replace mode, clear existing collections
    if (mode === "replace") {
      const existingCombos = await storage.getCombos();
      for (const c of existingCombos) await storage.deleteCombo(c.id);

      const existingProviders = await storage.getProviders();
      for (const p of existingProviders) await storage.deleteProvider(p.id);

      const existingRules = await storage.getRules();
      for (const r of existingRules) await storage.deleteRule(r.id);

      const existingKeys = await storage.getKeys();
      for (const k of existingKeys) await storage.deleteKey(k.id);
    }

    // Save Providers
    let providersSaved = 0;
    if (storage.saveProvidersBatch) {
      providersSaved = await storage.saveProvidersBatch(providersToSave);
    } else {
      for (const p of providersToSave) {
        await storage.saveProvider(p);
        providersSaved++;
      }
    }

    // Save Combos
    let combosSaved = 0;
    if (storage.saveCombosBatch) {
      combosSaved = await storage.saveCombosBatch(combosToSave);
    } else {
      for (const c of combosToSave) {
        await storage.saveCombo(c);
        combosSaved++;
      }
    }

    // Save Rules
    let rulesSaved = 0;
    if (storage.saveRulesBatch) {
      rulesSaved = await storage.saveRulesBatch(rulesToSave);
    } else {
      for (const r of rulesToSave) {
        await storage.saveRule(r);
        rulesSaved++;
      }
    }

    // Save Keys
    let keysSaved = 0;
    if (storage.saveKeysBatch) {
      keysSaved = await storage.saveKeysBatch(keysToSave);
    } else {
      for (const k of keysToSave) {
        await storage.saveKey(k);
        keysSaved++;
      }
    }

    return {
      success: true,
      format: is9R ? "9router" : "isoroute",
      mode,
      stats: {
        providersSaved,
        combosSaved,
        rulesSaved,
        keysSaved,
        connectionsPooled: pooledConns || undefined,
      },
      durationMs: Date.now() - start,
    };
  }
}
