import assert from "node:assert/strict";
import test from "node:test";
import { registerRedisSmokeRoutes } from "./redis-smoke.js";

type Handler = (request: unknown, response: { json(value: unknown): void }) => Promise<void>;

class FakeApp {
  readonly routes = new Map<string, Handler>();

  get(path: string, handler: Handler) {
    this.routes.set(path, handler);
  }
}

class FakeRedis {
  private readonly values = new Map<string, unknown>();

  async set(key: string, value: string) {
    this.values.set(key, value);
    return "OK";
  }

  async get(key: string) {
    return (this.values.get(key) as string | undefined) ?? null;
  }

  async del(key: string) {
    this.values.delete(key);
    return 1;
  }

  async hset(key: string, value: Record<string, string>) {
    this.values.set(key, value);
    return 1;
  }

  async hgetall(key: string) {
    return (this.values.get(key) as Record<string, string> | undefined) ?? {};
  }

  async rpush(key: string, ...values: string[]) {
    this.values.set(key, values);
    return values.length;
  }

  async lrange(key: string) {
    return (this.values.get(key) as string[] | undefined) ?? [];
  }

  async lpush(key: string, ...values: string[]) {
    this.values.set(key, values);
    return values.length;
  }

  async sadd(key: string, ...values: string[]) {
    this.values.set(key, new Set(values));
    return values.length;
  }

  async smembers(key: string) {
    return [...((this.values.get(key) as Set<string> | undefined) ?? new Set())];
  }

  async zadd(key: string, ...values: Array<number | string>) {
    this.values.set(key, values);
    return 2;
  }

  async zrange(key: string) {
    return (this.values.get(key) as Array<number | string> | undefined) ?? [];
  }

  pipeline() {
    return new FakeCommandChain();
  }

  multi() {
    return new FakeCommandChain();
  }

  call(command: string) {
    return Promise.reject(new Error(`Unknown command: ${command}`));
  }
}

class FakeCommandChain {
  set() {
    return this;
  }

  get() {
    return this;
  }

  exists() {
    return this;
  }

  exec() {
    return Promise.resolve([[null, "OK"]] as Array<[null, unknown]>);
  }
}

test("registers all Redis smoke routes", () => {
  const app = new FakeApp();
  registerRedisSmokeRoutes(app, new FakeRedis());

  assert.deepEqual([...app.routes.keys()], [
    "/redis/string",
    "/redis/missing",
    "/redis/hash",
    "/redis/list",
    "/redis/set",
    "/redis/sorted-set",
    "/redis/pipeline",
    "/redis/transaction",
    "/redis/expired",
    "/redis/failed",
    "/redis/wrong-type",
  ]);
});

test("returns the string smoke-test value and cleans it up", async () => {
  const app = new FakeApp();
  const redis = new FakeRedis();
  registerRedisSmokeRoutes(app, redis);
  let response: unknown;

  await app.routes.get("/redis/string")!(null, {
    json(value) {
      response = value;
    },
  });

  assert.deepEqual(response, { value: "hello" });
  assert.equal(await redis.get("serverdevtools:smoke:string"), null);
});
