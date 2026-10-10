import { afterEach, describe, expect, it, vi } from "vitest";

describe("platform API client", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("posts platform login to the configured backend route", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://fixion-center.onrender.com/v1");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: "test-token",
        user: { id: "admin-1", fullName: "Admin", email: "admin@example.com", role: "platform_admin" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { platformApi } = await import("../src/api/client");
    await platformApi.login("admin@example.com", "test-password");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://fixion-center.onrender.com/v1/platform/auth/login",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "admin@example.com", password: "test-password" }),
      }),
    );
  });
});
