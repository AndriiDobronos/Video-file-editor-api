import "dotenv/config";
import { serverConfig } from "./config.js";
import { buildApp } from "./app.js";
import {
  closeRedisClient,
  createBullmqConnection,
  createRedisClient,
} from "./lib/redis.js";
import { createVideoProcessingQueue } from "./lib/video-processing-queue.js";
import { startVideoProcessingWorker } from "./lib/worker-runtime.js";

const port = Number(process.env.PORT ?? serverConfig.defaultPort);
const host = process.env.HOST ?? serverConfig.defaultHost;
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map((value) => value.trim()).filter(Boolean)
  : serverConfig.defaultCorsOrigin;
const workerMode =
  (process.env.EMBED_WORKER ?? "").toLowerCase() === "true" ? "embedded" : "external";
const redis = createRedisClient("api");
const queue = createVideoProcessingQueue(createBullmqConnection("api"));

let embeddedWorker:
  | Awaited<ReturnType<typeof startVideoProcessingWorker>>
  | null = null;
let app:
  | Awaited<ReturnType<typeof buildApp>>
  | null = null;

try {
  if (workerMode === "embedded") {
    embeddedWorker = await startVideoProcessingWorker({
      label: "Embedded video processing worker is ready.",
    });
  }

  app = await buildApp({
    origin: corsOrigin,
    redis,
    queue,
    workerMode,
  });

  await app.listen({ port, host });
} catch (error) {
  console.error(error);
  if (app) {
    await app.close().catch(() => undefined);
  }
  if (embeddedWorker) {
    await embeddedWorker.close().catch(() => undefined);
  }
  await queue.close().catch(() => undefined);
  await closeRedisClient(redis);
  process.exit(1);
}

const shutdown = async () => {
  if (app) {
    await app.close();
  }
  if (embeddedWorker) {
    await embeddedWorker.close();
  }
  await queue.close();
  await closeRedisClient(redis);
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
