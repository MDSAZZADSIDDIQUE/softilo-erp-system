import { createDatabase, migrate } from "@softilo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RateLimiter } from "./lib/rate-limit.js";
import { buildServer } from "./server.js";

describe("rate limiter", () => {
  it("blocks at the limit and frees the key when the window ends", () => {
    const limiter = new RateLimiter(2, 1000);
    limiter.hit("a", 0);
    expect(limiter.retryAfter("a", 0)).toBe(0);
    limiter.hit("a", 0);
    expect(limiter.retryAfter("a", 100)).toBe(1);
    expect(limiter.retryAfter("b", 100)).toBe(0);
    expect(limiter.retryAfter("a", 1000)).toBe(0);
  });
});

describe("sign-in", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;
  let db: Awaited<ReturnType<typeof createDatabase>>;
  const login = (password: string) =>
    app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "owner@limits.example", password } });

  beforeAll(async () => {
    db = await createDatabase({});
    await migrate(db);
    app = await buildServer(db);
    await app.inject({ method: "POST", url: "/api/auth/signup", payload: {
      companyName: "Limits Ltd", name: "Owner", email: "owner@limits.example", password: "correct horse battery",
    } });
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it("refuses further attempts after ten failures, even with the right password", async () => {
    for (let i = 0; i < 9; i++) expect((await login("wrong password")).statusCode).toBe(401);
    expect((await login("correct horse battery")).statusCode).toBe(200);
    for (let i = 0; i < 10; i++) expect((await login("wrong password")).statusCode).toBe(401);
    const blocked = await login("correct horse battery");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeTruthy();
  });

  it("does not offer the demo unless the sample company exists", async () => {
    const res = await app.inject({ method: "GET", url: "/api/auth/demo" });
    expect(res.json()).toEqual({ available: false });
  });
});
