// Lightweight Web Crypto Administrative Authentication (default password: 123456)

function getEnvSafe(key: string, fallback: string): string {
  try {
    if (typeof process !== "undefined" && process?.env && process.env[key]) {
      return process.env[key]!;
    }
  } catch {}
  return fallback;
}

const ADMIN_PASSWORD = getEnvSafe("ADMIN_PASSWORD", "123456");
const AUTH_SECRET = getEnvSafe("AUTH_SECRET", "isoroute-secret-salt-2026");

export class AdminAuth {
  /**
   * Verify password and issue signed session token
   */
  static async login(password: string, expectedPassword?: string): Promise<{ success: boolean; token?: string; error?: string }> {
    const targetPassword = expectedPassword || ADMIN_PASSWORD;
    if (password !== targetPassword) {
      return { success: false, error: "Invalid administrative password" };
    }

    const token = await this.generateToken();
    return { success: true, token };
  }

  /**
   * Verify session token from Authorization header or Cookie or Headless Admin Key
   */
  static async verify(req: Request, expectedPassword?: string): Promise<boolean> {
    const targetPassword = expectedPassword || ADMIN_PASSWORD;

    // 1. Direct Headless Admin Key Header (9Router-style automation)
    const adminKeyHeader = req.headers.get("x-admin-key") || req.headers.get("x-api-key");
    if (adminKeyHeader && adminKeyHeader.trim() === targetPassword) {
      return true;
    }

    const authHeader = req.headers.get("Authorization");
    const cookieHeader = req.headers.get("Cookie");

    let token = "";
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.slice(7).trim();
    } else if (cookieHeader) {
      const match = cookieHeader.match(/edge_admin_token=([^;]+)/);
      if (match) token = match[1].trim();
    }

    if (!token) {
      try {
        const url = new URL(req.url);
        const queryToken = url.searchParams.get("token") || url.searchParams.get("admin_key");
        if (queryToken) token = queryToken.trim();
      } catch {}
    }

    if (!token) return false;

    // Direct password matching fallback for CLI/curl
    if (token === targetPassword) return true;

    try {
      const parts = token.split(".");
      if (parts.length !== 2) return false;
      const [timestampStr, signature] = parts;
      const timestamp = parseInt(timestampStr, 10);

      // Token valid for 7 days
      if (Date.now() - timestamp > 7 * 86400 * 1000) return false;

      const expectedSignature = await this.signTimestamp(timestampStr);
      return signature === expectedSignature;
    } catch {
      return false;
    }
  }

  private static async generateToken(): Promise<string> {
    const timestampStr = Date.now().toString();
    const signature = await this.signTimestamp(timestampStr);
    return `${timestampStr}.${signature}`;
  }

  private static async signTimestamp(timestamp: string): Promise<string> {
    const enc = new TextEncoder();
    const keyData = enc.encode(`${AUTH_SECRET}:${ADMIN_PASSWORD}`);
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, enc.encode(timestamp));
    return Array.from(new Uint8Array(signature))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 32);
  }
}
