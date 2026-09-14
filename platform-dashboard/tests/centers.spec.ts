import { describe, expect, it, vi } from "vitest";
import { ApiError, platformApi } from "../src/api/client";

describe("platform centers API", () => {
  it("requests server-side pagination and filters", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [], pagination: { page: 2, pageSize: 20, total: 0, totalPages: 0 } }), { status: 200 }));
    await platformApi.centers({ page: 2, pageSize: 20, search: "academy", status: "active" });
    expect(fetchMock.mock.calls[0][0]).toContain("page=2");
    expect(fetchMock.mock.calls[0][0]).toContain("search=academy");
    fetchMock.mockRestore();
  });

  it("preserves backend authorization errors as typed API errors", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { userMessage: "ليس لديك صلاحية" } }), { status: 403 }));
    await expect(platformApi.centers()).rejects.toMatchObject({ status: 403, message: "ليس لديك صلاحية" } satisfies Partial<ApiError>);
    fetchMock.mockRestore();
  });
});
