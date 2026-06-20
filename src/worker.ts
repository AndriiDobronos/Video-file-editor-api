import "dotenv/config";
import { startVideoProcessingWorker } from "./lib/worker-runtime.js";

const workerRuntime = await startVideoProcessingWorker();

const shutdown = async () => {
  await workerRuntime.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});
