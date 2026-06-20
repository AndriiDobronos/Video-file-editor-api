import type { Redis } from "ioredis";

export async function setJsonRecord<T>(redis: Redis, key: string, value: T) {
  await redis.set(key, JSON.stringify(value));
}

export async function getJsonRecord<T>(redis: Redis, key: string): Promise<T | null> {
  const rawValue = await redis.get(key);

  if (!rawValue) {
    return null;
  }

  return JSON.parse(rawValue) as T;
}

export async function getManyJsonRecords<T>(
  redis: Redis,
  keys: string[],
): Promise<T[]> {
  if (keys.length === 0) {
    return [];
  }

  const rawValues = await redis.mget(keys);

  return rawValues.flatMap((value) => {
    if (!value) {
      return [];
    }

    return [JSON.parse(value) as T];
  });
}
