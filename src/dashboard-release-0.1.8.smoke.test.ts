import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import express from "express";
import ServerDevTools from "server-devtools";

const require = createRequire(import.meta.url);
const distSrcRoot = dirname(require.resolve("server-devtools"));
const packageInstallRoot = dirname(dirname(distSrcRoot));
const { isSlowSpan } = require(join(distSrcRoot, "core/slow-span.js")) as {
  isSlowSpan: (durationMs: unknown, thresholdMs?: number) => boolean;
};
const Config = require(join(distSrcRoot, "config/index.js")).default as {
  DASHBOARD_LOGIN_BODY_LIMIT_BYTES: number;
};

const AUTH = { username: "admin", password: "correct-password" } as const;
const processFailures: unknown[] = [];
process.on("unhandledRejection", (error) => processFailures.push(error));
process.on("uncaughtException", (error) => processFailures.push(error));

function useTemporaryWorkingDirectory(t: TestContext) {
  const previousDirectory = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "express-dashboard-smoke-"));
  process.chdir(directory);
  t.after(() => {
    process.chdir(previousDirectory);
    rmSync(directory, { recursive: true, force: true });
  });
}

type HarnessOptions = {
  allowedIPs?: string[];
  slowSpanThresholdMs?: number;
  auth?: { username: string; password: string };
  useExpress?: boolean;
};

async function startHarness(
  t: TestContext,
  options: HarnessOptions = {},
  hooks: { afterEach?: boolean } = { afterEach: true },
) {
  const devtools = new ServerDevTools({
    auth: options.auth ?? AUTH,
    allowedIPs: options.allowedIPs,
    slowSpanThresholdMs: options.slowSpanThresholdMs,
  });

  const app = options.useExpress ? express() : undefined;
  const server = app
    ? (() => {
        app.use((req, res, next) => devtools.middleware(req, res, next));
        app.get("/app-route", (_req, res) => res.json({ ok: true }));
        return http.createServer(app);
      })()
  : http.createServer((req, res) => {
      devtools.middleware(req, res, () => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ route: "app" }));
      });
    });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    (devtools as unknown as { storage: { close: () => void } }).storage.close();
  };
  if (hooks.afterEach) {
    t.after(stop);
  }

  return { devtools, baseUrl, stop };
}

function postLogin(baseUrl: string, body: string) {
  return fetch(`${baseUrl}/_devtools/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(5000),
  });
}

async function loginCookie(baseUrl: string, username = AUTH.username, password = AUTH.password) {
  const response = await postLogin(baseUrl, JSON.stringify({ username, password }));
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  return setCookie.split(";")[0];
}

function countSessionRows(where = ""): number {
  const database = new DatabaseSync("./server-devtools.db");
  const row = database.prepare(`SELECT COUNT(*) AS count FROM sessions ${where}`).get() as { count: number };
  database.close();
  return row.count;
}

test("installed server-devtools is 0.1.8", () => {
  const pkg = JSON.parse(
    readFileSync(join(packageInstallRoot, "package.json"), "utf8"),
  ) as { version: string };
  assert.equal(pkg.version, "0.1.8");
});

test("omitted allowedIPs keeps dashboard login and API available", async (t) => {
  useTemporaryWorkingDirectory(t);
  const { baseUrl } = await startHarness(t);
  const cookie = await loginCookie(baseUrl);
  assert.equal(
    (await fetch(`${baseUrl}/_devtools/api/auth/profile`, { headers: { cookie } })).status,
    200,
  );
  const appResponse = await fetch(`${baseUrl}/express-smoke-route`);
  assert.equal(appResponse.status, 200);
  assert.deepEqual(await appResponse.json(), { route: "app" });
});

test("empty allowedIPs array preserves unrestricted dashboard access", async (t) => {
  useTemporaryWorkingDirectory(t);
  const { baseUrl } = await startHarness(t, { allowedIPs: [] });
  assert.equal((await postLogin(baseUrl, JSON.stringify(AUTH))).status, 200);
});

test("non-allowed client IPs receive 403 on login and authenticated API routes", async (t) => {
  useTemporaryWorkingDirectory(t);
  const { baseUrl } = await startHarness(t, { allowedIPs: ["192.0.2.10"] });

  for (const path of ["/_devtools/api/auth/login", "/_devtools/api/auth/profile", "/_devtools/api/config"]) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: path.endsWith("/login") ? "POST" : "GET",
      headers: path.endsWith("/login")
        ? { "content-type": "application/json" }
        : undefined,
      body: path.endsWith("/login") ? JSON.stringify(AUTH) : undefined,
    });
    assert.equal(response.status, 403, path);
    assert.deepEqual(await response.json(), { message: "Forbidden" });
  }
});

test("application routes stay reachable when dashboard is IP-restricted", async (t) => {
  useTemporaryWorkingDirectory(t);
  const { baseUrl } = await startHarness(t, { allowedIPs: ["192.0.2.10"], useExpress: true });
  const response = await fetch(`${baseUrl}/app-route`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("malformed login JSON returns 400 without crashing the host", async (t) => {
  useTemporaryWorkingDirectory(t);
  const { baseUrl } = await startHarness(t, { useExpress: true });

  for (const body of ["{", '{"username":', "not-json"]) {
    const response = await postLogin(baseUrl, body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { message: "Login request body must be valid JSON" });
  }

  assert.equal((await fetch(`${baseUrl}/app-route`)).status, 200);
  assert.deepEqual(processFailures, []);
});

test("malformed session cookies are treated as unauthenticated", async (t) => {
  useTemporaryWorkingDirectory(t);
  const { baseUrl } = await startHarness(t, { useExpress: true });

  for (const cookie of ["sdt_session=%E0%A4%A", "sdt_session=%", "other=1; sdt_session=%ZZ"]) {
    const response = await fetch(`${baseUrl}/_devtools/api/auth/profile`, {
      headers: { cookie },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { message: "Unauthorized" });
  }

  assert.equal((await fetch(`${baseUrl}/app-route`)).status, 200);
});

test("sessions survive restart with unchanged credentials", async (t) => {
  useTemporaryWorkingDirectory(t);
  const first = await startHarness(t, {}, { afterEach: false });
  const cookie = await loginCookie(first.baseUrl);
  await first.stop();

  const restarted = await startHarness(t, {}, { afterEach: false });
  t.after(async () => {
    await restarted.stop();
  });
  assert.equal(countSessionRows(), 1);
  const response = await fetch(`${restarted.baseUrl}/_devtools/api/auth/profile`, { headers: { cookie } });
  assert.equal(response.status, 200);
});

test("sessions invalidate after dashboard password changes", async (t) => {
  useTemporaryWorkingDirectory(t);
  const first = await startHarness(t, {}, { afterEach: false });
  const cookie = await loginCookie(first.baseUrl);
  await first.stop();

  const rotated = await startHarness(t, { auth: { username: "admin", password: "new-password" } }, { afterEach: false });
  t.after(async () => {
    await rotated.stop();
  });
  assert.equal(countSessionRows(), 0);
  assert.equal(
    (await fetch(`${rotated.baseUrl}/_devtools/api/auth/profile`, { headers: { cookie } })).status,
    401,
  );
  await loginCookie(rotated.baseUrl, "admin", "new-password");
});

test("login removes expired session rows", async (t) => {
  useTemporaryWorkingDirectory(t);
  const { baseUrl } = await startHarness(t);
  const validCookie = await loginCookie(baseUrl);

  const database = new DatabaseSync("./server-devtools.db");
  database.exec(`
    INSERT INTO sessions (session_hash, username, created_at, expires_at)
    VALUES ('expired-row', 'admin', 1, ${Date.now() - 1});
  `);
  database.close();
  assert.equal(countSessionRows(), 2);

  await loginCookie(baseUrl);
  assert.equal(countSessionRows("WHERE session_hash = 'expired-row'"), 0);
  assert.equal((await fetch(`${baseUrl}/_devtools/api/auth/profile`, { headers: { cookie: validCookie } })).status, 200);
});

test("blocks the sixth failed login with 429", async (t) => {
  useTemporaryWorkingDirectory(t);
  const { baseUrl } = await startHarness(t);
  const wrong = JSON.stringify({ username: "admin", password: "wrong" });

  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await postLogin(baseUrl, wrong)).status, 401);
  }

  const blocked = await postLogin(baseUrl, wrong);
  assert.equal(blocked.status, 429);
  assert.deepEqual(await blocked.json(), { message: "Too many login attempts" });
  assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
});

test("rejects oversized login bodies with 413", async (t) => {
  useTemporaryWorkingDirectory(t);
  const { baseUrl } = await startHarness(t);
  const oversized = JSON.stringify({
    username: "admin",
    password: "wrong",
    padding: "x".repeat(Config.DASHBOARD_LOGIN_BODY_LIMIT_BYTES),
  });
  const response = await postLogin(baseUrl, oversized);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { message: "Login request body is too large" });
});

test("exposes configured slowSpanThresholdMs from the config API", async (t) => {
  useTemporaryWorkingDirectory(t);
  const { baseUrl } = await startHarness(t, { slowSpanThresholdMs: 275, allowedIPs: ["127.0.0.1"] });
  const cookie = await loginCookie(baseUrl);
  const response = await fetch(`${baseUrl}/_devtools/api/config`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { slowSpanThresholdMs: 275 });
});

test("isSlowSpan flags leaf durations without inferring slowness from children", () => {
  assert.equal(isSlowSpan(50), false);
  assert.equal(isSlowSpan(900), true);
  assert.equal(isSlowSpan(50, 500), false);
  assert.equal(isSlowSpan(900, 500), true);
});