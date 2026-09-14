import { describe, expect, it } from "vitest";
import { clearSession, getSession, setSession } from "../src/auth/authStore";

describe("platform auth foundation", () => {
  it("persists and clears a platform session", () => {
    const session = { accessToken: "token", admin: { id: "1", email: "admin@example.com", role: "platform_admin" as const } };
    setSession(session);
    expect(getSession()).toEqual(session);
    clearSession();
    expect(getSession()).toBeNull();
  });
});
