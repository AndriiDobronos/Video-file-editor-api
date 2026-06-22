import cors from "@fastify/cors";
import type { Queue } from "bullmq";
import Fastify from "fastify";
import type { Redis } from "ioredis";
import { ensureStorageDirectories } from "./lib/filesystem.js";
import {
  assertObjectStorageReady,
  checkObjectStorageHealth,
  getMediaStorageDriver,
  type ObjectStorageHealth,
} from "./lib/object-storage.js";
import { registerMediaRoutes } from "./routes/media-routes.js";
import type { QueueJobData, QueueJobResult } from "./types.js";

type BuildAppOptions = {
  origin?: true | string | string[];
  redis: Redis;
  queue: Queue<QueueJobData, QueueJobResult>;
  workerMode?: "embedded" | "external";
};

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: true,
  });

  await ensureStorageDirectories();
  assertObjectStorageReady();

  let objectStorageHealth: ObjectStorageHealth | null = null;

  try {
    objectStorageHealth = await checkObjectStorageHealth();

    if (objectStorageHealth.status === "error") {
      app.log.error(
        {
          objectStorage: objectStorageHealth,
        },
        "Object storage health check failed.",
      );
    } else {
      app.log.info(
        {
          objectStorage: objectStorageHealth,
        },
        "Object storage health check completed.",
      );
    }
  } catch (error) {
    objectStorageHealth = {
      status: "error",
      storageDriver: getMediaStorageDriver(),
      bucket: null,
      endpoint: null,
      message: error instanceof Error ? error.message : "Unexpected object storage failure.",
      checkedAt: new Date().toISOString(),
    };

    app.log.error(
      {
        error,
        objectStorage: objectStorageHealth,
      },
      "Unexpected object storage health check error.",
    );
  }

  await app.register(cors, {
    origin: options.origin ?? true,
    methods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept", "Authorization"],
  });

  const buildServiceSnapshot = async () => {
    const redisStatus = await options.redis
      .ping()
      .then(() => "ok")
      .catch(() => "error");

    return {
      status:
        redisStatus === "ok" && objectStorageHealth?.status !== "error"
          ? "ok"
          : "degraded",
      service: "video-file-editor-api",
      redis: redisStatus,
      storageDriver: getMediaStorageDriver(),
      objectStorage: objectStorageHealth?.status ?? "unknown",
      objectStorageBucket: objectStorageHealth?.bucket ?? null,
      objectStorageMessage: objectStorageHealth?.message ?? null,
      objectStorageCheckedAt: objectStorageHealth?.checkedAt ?? null,
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
