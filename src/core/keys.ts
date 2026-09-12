// Consumer API Key Lifecycle, Billing Quotas & Guard Policies
import type { ChatCompletionRequest } from "../types";
import { RewriteEngine } from "./rewrite";

export interface ApiKeyRecord {
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

export interface KeyValidationResult {
  valid: boolean;
  statusCode?: number;
  error?: string;
  keyRecord?: ApiKeyRecord;
}

export class KeyManager {
  /**
   * Validate incoming client request against API key constraints
   */
  static validate(
    req: Request,
    body: ChatCompletionRequest,
    keyRecord: ApiKeyRecord
  ): KeyValidationResult {
    // 1. Status Check
    if (!keyRecord.enabled) {
      return { valid: false, statusCode: 403, error: "API key is disabled" };
    }

    // 2. Expiration Check
    if (keyRecord.expiresAt && keyRecord.expiresAt > 0 && Date.now() > keyRecord.expiresAt) {
      return { valid: false, statusCode: 403, error: "API key has expired" };
    }

    // 3. Request Count Quota
    if (keyRecord.maxRequests && keyRecord.maxRequests > 0 && keyRecord.usedRequests >= keyRecord.maxRequests) {
      return { valid: false, statusCode: 429, error: "API key request quota exhausted" };
    }

    // 4. Token Quotas
    if (keyRecord.maxTokens && keyRecord.maxTokens > 0 && keyRecord.usedTokens >= keyRecord.maxTokens) {
      return { valid: false, statusCode: 429, error: "API key total token quota exhausted" };
    }
    if (keyRecord.maxPromptTokens && keyRecord.maxPromptTokens > 0 && keyRecord.usedPromptTokens >= keyRecord.maxPromptTokens) {
      return { valid: false, statusCode: 429, error: "API key prompt token quota exhausted" };
    }
    if (keyRecord.maxCompletionTokens && keyRecord.maxCompletionTokens > 0 && keyRecord.usedCompletionTokens >= keyRecord.maxCompletionTokens) {
      return { valid: false, statusCode: 429, error: "API key completion token quota exhausted" };
    }

    // 5. Header Guard Policy (Required Headers Check)
    if (keyRecord.requiredHeaders) {
      for (const [headerName, expectedValue] of Object.entries(keyRecord.requiredHeaders)) {
        const actualValue = req.headers.get(headerName);
        if (!actualValue) {
          return { valid: false, statusCode: 403, error: `Missing required header: '${headerName}'` };
        }
        if (expectedValue !== "*" && actualValue !== expectedValue) {
          return { valid: false, statusCode: 403, error: `Header '${headerName}' value mismatch` };
        }
      }
    }

    // 6. Body Keyword / Signature Detection Guard
    if (keyRecord.requiredBodyKeywords && keyRecord.requiredBodyKeywords.length > 0) {
      const rawBody = JSON.stringify(body);
      for (const kw of keyRecord.requiredBodyKeywords) {
        if (!rawBody.includes(kw)) {
          return { valid: false, statusCode: 403, error: `Payload missing required security signature: '${kw}'` };
        }
      }
    }

    // 7. Allowed Models Whitelist
    if (keyRecord.allowedModels && keyRecord.allowedModels.length > 0) {
      const requestedModel = body.model || "";
      const isAllowed = keyRecord.allowedModels.some((pattern) => {
        try {
          const regex = RewriteEngine.compilePattern(pattern.trim());
          return regex.test(requestedModel);
        } catch {
          return pattern.trim() === requestedModel;
        }
      });

      if (!isAllowed) {
        return { valid: false, statusCode: 403, error: `Model '${requestedModel}' is not authorized for this API key` };
      }
    }

    return { valid: true, keyRecord };
  }

  /**
   * Helper to generate high-entropy secure API key string
   */
  static generateSecretKey(prefix = "er-live-"): string {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${prefix}${hex}`;
  }
}
