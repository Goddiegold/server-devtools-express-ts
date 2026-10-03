import { randomUUID } from "node:crypto";

const KEY_PREFIX = "serverdevtools:smoke:";
const STRING_TTL_SECONDS = 30;
const EXPIRY_WAIT_MS = 75;

type RedisCommandResult = [Error | null, unknown];

export interface RedisSmokeClient {
  set(key: string, value: string, ...options: Array<string | number>): Promise<unknown>;
  get(key: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  hset(key: string, value: Record<string, string>): Promise<unknown>;
  hgetall(key: string): Promise<unknown>;
  rpush(key: string, ...values: string[]): Promise<unknown>;
  lrange(key: string, start: number, stop: number | string): Promise<unknown>;
  sadd(key: string, ...values: string[]): Promise<unknown>;
  smembers(key: string): Promise<unknown>;
  zadd(key: string, ...values: Array<number | string>): Promise<unknown>;
  zrange(key: string, start: number, stop: number | string, withScores: string): Promise<unknown>;
  lpush(key: string, ...values: string[]): Promise<unknown>;
  call(command: string): Promise<unknown>;
  pipeline(): RedisSmokeCommandChain;
  multi(): RedisSmokeCommandChain;
}

interface RedisSmokeCommandChain {
  set(key: string, value: string, ...options: Array<string | number>): RedisSmokeCommandChain;
  get(key: string): RedisSmokeCommandChain;
  exists(key: string): RedisSmokeCommandChain;
  exec(): Promise<RedisCommandResult[] | null>;
}

interface RouteRegistrar {
  get(path: string, handler: RouteHandler): unknown;
}

interface RouteResponse {
  json(value: unknown): unknown;
}

type RouteHandler = (request: unknown, response: RouteResponse) => unknown;

function key(name: string): string {
  return `${KEY_PREFIX}${name}:${randomUUID()}`;
}

function checkCommandResults(results: RedisCommandResult[]): unknown[] {
  for (const [error] of results) {
    if (error) throw error;
  }
  return results.map(([, result]) => result);
}

async function cleanup(redis: RedisSmokeClient, redisKey: string): Promise<void> {
  await redis.del(redisKey).catch(() => undefined);
}

export function registerRedisSmokeRoutes(app: RouteRegistrar, redis: RedisSmokeClient): void {
  app.get("/redis/string", async (_request, response) => {
    const redisKey = key("string");
    try {
      await redis.set(redisKey, "hello", "EX", STRING_TTL_SECONDS);
      response.json({ value: await redis.get(redisKey) });
    } finally {
      await cleanup(redis, redisKey);
    }
  });

  app.get("/redis/missing", async (_request, response) => {
    const redisKey = key("missing");
    response.json({ value: await redis.get(redisKey) });
  });

  app.get("/redis/hash", async (_request, response) => {
    const redisKey = key("hash");
    try {
      await redis.hset(redisKey, { field: "value" });
      response.json({ value: await redis.hgetall(redisKey) });
    } finally {
      await cleanup(redis, redisKey);
    }
  });

  app.get("/redis/list", async (_request, response) => {
    const redisKey = key("list");
    try {
      await redis.rpush(redisKey, "first", "second");
      response.json({ value: await redis.lrange(redisKey, 0, -1) });
    } finally {
      await cleanup(redis, redisKey);
    }
  });

  app.get("/redis/set", async (_request, response) => {
    const redisKey = key("set");
    try {
      await redis.sadd(redisKey, "one", "two");
      const values = (await redis.smembers(redisKey) as string[]).sort();
      response.json({ value: values });
    } finally {
      await cleanup(redis, redisKey);
    }
  });

  app.get("/redis/sorted-set", async (_request, response) => {
    const redisKey = key("sorted-set");
    try {
      await redis.zadd(redisKey, 1, "one", 2, "two");
      response.json({ value: await redis.zrange(redisKey, 0, "-1", "WITHSCORES") });
    } finally {
      await cleanup(redis, redisKey);
    }
  });

  app.get("/redis/pipeline", async (_request, response) => {
    const redisKey = key("pipeline");
    try {
      const results = await redis
        .pipeline()
        .set(redisKey, "pipeline-value", "EX", STRING_TTL_SECONDS)
        .get(redisKey)
        .exists(redisKey)
        .exec();
      response.json({ value: checkCommandResults(results ?? []) });
    } finally {
      await cleanup(redis, redisKey);
    }
  });

  app.get("/redis/transaction", async (_request, response) => {
    const redisKey = key("transaction");
    try {
      const results = await redis
        .multi()
        .set(redisKey, "transaction-value", "EX", STRING_TTL_SECONDS)
        .get(redisKey)
        .exists(redisKey)
        .exec();
      response.json({ value: checkCommandResults(results ?? []) });
    } finally {
      await cleanup(redis, redisKey);
    }
  });

  app.get("/redis/expired", async (_request, response) => {
    const redisKey = key("expired");
    try {
      await redis.set(redisKey, "short-lived", "PX", EXPIRY_WAIT_MS);
      await new Promise((resolve) => setTimeout(resolve, EXPIRY_WAIT_MS + 25));
      response.json({ value: await redis.get(redisKey) });
    } finally {
      await cleanup(redis, redisKey);
    }
  });

  app.get("/redis/failed", async () => {
    await redis.call("SERVERDEVTOOLS_INVALID_COMMAND");
  });

  app.get("/redis/wrong-type", async (_request, response) => {
    const redisKey = key("wrong-type");
    try {
      await redis.set(redisKey, "string", "EX", STRING_TTL_SECONDS);
      await redis.lpush(redisKey, "not-a-list");
      response.json({ value: "unreachable" });
    } finally {
      await cleanup(redis, redisKey);
    }
  });
}
