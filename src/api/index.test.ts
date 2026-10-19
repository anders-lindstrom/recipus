import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execute, execSync } = vi.hoisted(() => ({
  execute: vi.fn(),
  execSync: vi.fn(() => { throw new Error("health must not invoke git"); }),
}));

vi.mock("@/db", () => ({ db: { execute } }));
vi.mock("node:child_process", () => ({ execSync }));

import { createApp } from "./index";

const SHA = "abcdef1234567890abcdef1234567890abcdef12";

describe("GET /api/health", () => {
  beforeEach(() => {
    execute.mockReset();
    execSync.mockClear();
    vi.stubEnv("RECIPUS_GIT_SHA", SHA);
    vi.stubEnv("DEV_AUTH_USER", "");
    vi.stubEnv("PROXY_AUTH_SECRET", "");
  });

  afterEach(() => {
    expect(execSync).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("reports the 12-character build SHA and existing healthy fields without auth", async () => {
    execute.mockResolvedValue([]);

    const res = await createApp().request("/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", db: "up", sha: SHA.slice(0, 12) });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps the degraded response and status when the database fails", async () => {
    execute.mockRejectedValue(new Error("database unavailable"));

    const res = await createApp().request("/api/health");

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "degraded", db: "down", sha: SHA.slice(0, 12) });
  });

  it.each([undefined, "", "   "])("returns dev without git when the SHA is %j", async (sha) => {
    vi.stubEnv("RECIPUS_GIT_SHA", sha);
    execute.mockResolvedValue([]);

    const res = await createApp().request("/api/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", db: "up", sha: "dev" });
  });

  it("trims the build environment value before shortening it", async () => {
    vi.stubEnv("RECIPUS_GIT_SHA", `  ${SHA}\n`);
    execute.mockResolvedValue([]);

    const res = await createApp().request("/api/health");

    expect((await res.json()).sha).toBe(SHA.slice(0, 12));
  });
});
