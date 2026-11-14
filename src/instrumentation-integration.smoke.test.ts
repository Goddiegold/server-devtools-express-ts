import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Redis from "ioredis";
import mongoose from "mongoose";
import mysql from "mysql2/promise";
import { Pool } from "pg";
import ServerDevTools from "server-devtools";

const AUTH = { username: "admin", password: "correct-password" };

const POSTGRES_URL = "postgresql://mac@localhost:5432/server_devtools_test";
const MYSQL_CONFIG = {
  host: "localhost",
  port: 3306,
  user: "devtools",
  password: "devtools",
  database: "server_devtools_test",
};
const MONGO_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

async function assertReachable(label: string, probe: () => Promise<void>) {
  try {
    await probe();
  } catch (error) {
    assert.fail(
      `INFRA BLOCKER (${label}): service unreachable — start the smoke database/Redis stack and retry. ${error}`,
    );
  }
}

test("PostgreSQL is reachable for tracing smoke", async () => {
  const pool = new Pool({ connectionString: POSTGRES_URL });
  try {
    await assertReachable("PostgreSQL", async () => {
      await pool.query("SELECT 1");
    });
  } finally {
    await pool.end();
  }
});

test("MySQL is reachable for tracing smoke", async () => {
  const pool = mysql.createPool(MYSQL_CONFIG);
  try {
    await assertReachable("MySQL", async () => {
      await pool.query("SELECT 1");
    });
  } finally {
    await pool.end();
  }
});

test("MongoDB is reachable for tracing smoke", async () => {
  await assertReachable("MongoDB", async () => {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 2000 });
    await mongoose.connection.db?.command({ ping: 1 });
    await mongoose.disconnect();
  });
});

test("Redis is reachable for tracing smoke", async () => {
  const redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    lazyConnect: true,
  });
  try {
    await assertReachable("Redis", async () => {
      const pong = await redis.ping();
      assert.equal(pong, "PONG");
    });
  } finally {
    redis.disconnect();
  }
});

test("published ServerDevTools instruments an HTTP handler and records a request", async (t) => {
  const previousDirectory = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "express-instrumentation-smoke-"));
  process.chdir(directory);
  t.after(() => {
    process.chdir(previousDirectory);
    rmSync(directory, { recursive: true, force: true });
  });

  const devtools = new ServerDevTools({ auth: AUTH });
  await devtools.start();

  const server = http.createServer((req, res) => {
    devtools.middleware(req, res, () => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ping: true }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    (devtools as unknown as { storage: { close: () => void } }).storage.close();
  });

  await fetch(`${baseUrl}/instrumented-route`);

  const login = await fetch(`${baseUrl}/_devtools/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(AUTH),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);

  await new Promise((resolve) => setTimeout(resolve, 500));

  const requests = await fetch(`${baseUrl}/_devtools/api/requests`, { headers: { cookie } });
  assert.equal(requests.status, 200);
  const payload = await requests.json();
  const list = Array.isArray(payload)
    ? payload
  : typeof payload === "object" && payload !== null && Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: Array<{ path?: string; route?: string }> }).data
  : typeof payload === "object" && payload !== null && Array.isArray((payload as { items?: unknown }).items)
    ? (payload as { items: Array<{ path?: string; route?: string }> }).items
    : null;
  assert.ok(list, `unexpected /requests payload: ${JSON.stringify(payload)}`);
  assert.ok(
    list.some((item) => item.path === "/instrumented-route" || item.route === "/instrumented-route"),
    `expected instrumented route in requests: ${JSON.stringify(list)}`,
  );
});