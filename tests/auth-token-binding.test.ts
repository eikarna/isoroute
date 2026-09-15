import { describe, expect, it } from "bun:test";
import { AdminAuth } from "../src/core/auth";

describe("admin session tokens", () => {
  it("does not validate a token minted under a different configured password", async () => {
    const firstPassword = "admin-password-a";
    const secondPassword = "admin-password-b";
    const login = await AdminAuth.login(firstPassword, firstPassword);
    expect(login.success).toBe(true);

    const request = new Request("https://isoroute.test/admin", {
      headers: { Authorization: `Bearer ${login.token}` },
    });

    expect(await AdminAuth.verify(request, secondPassword)).toBe(false);
  });
});
