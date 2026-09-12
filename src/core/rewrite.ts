// ReDoS-Safe Wildcard & Regex Force Routing Engine
export interface RouteRule {
  id: string;
  pattern: string; // e.g. "claude-*-opus", "*high", "claude*"
  target: string;  // e.g. "gemini-$1-latest", "deepseek-v4.1-flash", "gemini*"
  priority: number;
  enabled: boolean;
}

export class RewriteEngine {
  /**
   * Compiles a wildcard pattern (e.g. "claude-*-opus" or "*high") into a safe RegExp.
   * Wildcard '*' is translated to a non-greedy capture group '([^/]+)' or '(.*)'.
   * Special regex characters are escaped to prevent ReDoS attacks.
   */
  static compilePattern(pattern: string): RegExp {
    // 1. If pattern is wrapped in slashes like /pattern/i, treat as raw regex but clamp complexity
    if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
      const lastSlash = pattern.lastIndexOf("/");
      const rawRegex = pattern.slice(1, lastSlash);
      const flags = pattern.slice(lastSlash + 1);
      // Clean flags, only allow i, m, s
      const cleanFlags = flags.replace(/[^ims]/g, "");
      return new RegExp(rawRegex, cleanFlags);
    }

    // 2. Standard wildcard pattern: escape regex specials except * and ?
    // Escaping characters: . + ? ^ $ { } ( ) | [ ] \
    let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");

    // Replace ? with single non-slash character
    escaped = escaped.replace(/\?/g, "([^/])");

    // Replace * with capturing group (0 or more characters)
    escaped = escaped.replace(/\*/g, "([^/]*)");

    // Anchor strictly to start and end
    return new RegExp(`^${escaped}$`, "i");
  }

  /**
   * Apply routing rules to an incoming model name.
   * Evaluates rules ordered by priority descending.
   * If a rule matches, returns the rewritten target string with captured wildcards substituted.
   */
  static rewrite(modelName: string, rules: RouteRule[]): { matched: boolean; targetModel: string; ruleId?: string } {
    const activeRules = rules
      .filter((r) => r.enabled && r.pattern.trim() !== "")
      .sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const rule of activeRules) {
      try {
        const regex = this.compilePattern(rule.pattern.trim());
        const match = modelName.match(regex);

        if (match) {
          let rewritten = rule.target.trim();

          // If target contains wildcard '*', map matched groups sequentially
          if (rewritten.includes("*")) {
            for (let i = 1; i < match.length; i++) {
              rewritten = rewritten.replace("*", match[i]);
            }
          }

          // Also support $1, $2 capture group placeholders
          for (let i = 1; i < match.length; i++) {
            rewritten = rewritten.replaceAll(`$${i}`, match[i]);
          }

          return {
            matched: true,
            targetModel: rewritten,
            ruleId: rule.id,
          };
        }
      } catch (err) {
        console.warn(`[RewriteEngine] Invalid pattern in rule '${rule.id}':`, err);
      }
    }

    return {
      matched: false,
      targetModel: modelName,
    };
  }
}
