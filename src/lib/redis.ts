import type { ConnectionOptions } from "bullmq";
import {
  Redis as RedisCtor,
  type Redis as RedisClient,
  type RedisOptions,
} from "ioredis";
import { serverConfig } from "../config.js";

export type RedisRole = "api" | "worker";

function parseRedisUrl(redisUrl: string) {
  const parsed = new URL(redisUrl);
  const pathname = parsed.pathname.replace(/^\//, "");
  const db = pathname ? Number(pathname) : undefined;

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
    username: parsed.username || undefined,
    password: parsed.password || undefined,
    db: typeof db === "number" && Number.isFinite(db) ? db : undefined,
    tls: parsed.protocol === "rediss:" ? {} : undefined,
  };
}

function buildRedisOptions(role: RedisRole): RedisOptions {
  const redisUrl = process.env.REDIS_URL;
  const urlOptions = redisUrl ? parseRedisUrl(redisUrl) : null;

  return {
    host: urlOptions?.host ?? process.env.REDIS_HOST ?? serverConfig.redis.host,
    port: urlOptions?.port ?? Number(process.env.REDIS_PORT ?? serverConfig.redis.port),
    db: urlOptions?.db ?? Number(process.env.REDIS_DB ?? serverConfig.redis.db),
    username: urlOptions?.username,
    password: urlOptions?.password ?? process.env.REDIS_PASSWORD ?? undefined,
    tls: urlOptions?.tls,
    maxRetriesPerRequest: role === "worker" ? null : 1,
  };
}

export function createBullmqConnection(role: RedisRole): ConnectionOptions {
  const options = buildRedisOptions(role);

  return {
    host: options.host,
    port: options.port,
    db: options.db,
    username: options.username,
    password: options.password,
    tls: options.tls,
    maxRetriesPerRequest: options.maxRetriesPerRequest,
  };
}

export function createRedisClient(role: RedisRole): RedisClient {
  const redisUrl = process.env.REDIS_URL;
  const options = buildRedisOptions(role);

  if (redisUrl) {
    return new RedisCtor(redisUrl, {
      maxRetriesPerRequest: options.maxRetriesPerRequest,
    });
  }

  return new RedisCtor(options);
}

export async function closeRedisClient(client: RedisClient) {
  if (client.status === "end") {
    return;
  }

  await client.quit().catch(async () => {
    client.disconnect();
  });
}
