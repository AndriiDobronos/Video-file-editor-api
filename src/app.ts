import cors from "@fastify/cors";
import type { Queue } from "bullmq";
import Fastify from "fastify";
import type { Redis } from "ioredis";
import { ensureStorageDirectories } from "./lib/filesystem.js";
import { assertObjectStorageReady, getMediaStorageDriver } from "./lib/object-storage.js";
import { registerMediaRoutes } from "./routes/media-routes.js";
import type { QueueJobData, QueueJobResult } from "./types.js";

type BuildAppOptions = {
  origin?: true | string | string[];
  redis: Redis;
  queue: Queue<QueueJobData, QueueJobResult>;
  workerMode?: "embedded" | "external";
};

export async function buildApp(options: BuildAppOptions) {
  await ensureStorageDirectories();
  assertObjectStorageReady();

  const app = Fastify({
    logger: true,
  });

  await app.register(cors, {
    origin: options.origin ?? true,
  });

  const buildServiceSnapshot = async () => {
    const redisStatus = await options.redis
      .ping()
      .then(() => "ok")
      .catch(() => "error");

    return {
      status: redisStatus === "ok" ? "ok" : "degraded",
      service: "video-file-editor-api",
      redis: redisStatus,
      storageDriver: getMediaStorageDriver(),
      workerMode: options.workerMode ?? "external",
      timestamp: new Date().toISOString(),
    };
  };

  app.get("/health", async () => {
    return buildServiceSnapshot();
  });

  app.get("/wake", async () => {
    return buildServiceSnapshot();
  });

  await registerMediaRoutes(app, {
    redis: options.redis,
    queue: options.queue,
  });

  return app;
}
