import {
  closeRedisClient,
  createBullmqConnection,
  createRedisClient,
} from "./redis.js";
import {
  markJobCompleted,
  markJobFailed,
  markJobProcessing,
  updateJobProgress,
} from "./jobs.js";
import {
  processConvertImageJob,
  processMergeJob,
  processNormalizeJob,
  processTrimJob,
} from "./media.js";
import { createVideoProcessingWorker } from "./video-processing-queue.js";
import type {
  ConvertImageJobOptions,
  JobProgress,
  MergeJobOptions,
  NormalizeJobOptions,
  QueueJobResult,
  TrimJobOptions,
} from "../types.js";

type StartWorkerOptions = {
  label?: string;
};

export async function startVideoProcessingWorker(options: StartWorkerOptions = {}) {
  const redis = createRedisClient("worker");
  const worker = createVideoProcessingWorker(
    createBullmqConnection("worker"),
    async (job): Promise<QueueJobResult> => {
      if (!job.id) {
        throw new Error("BullMQ job id is missing.");
      }

      const reportProgress = async (progress: JobProgress) => {
        await job.updateProgress(progress ?? 0);
      };

      if (job.name === "trim") {
        const outputAsset = await processTrimJob(
          redis,
          job.data.options as TrimJobOptions,
          reportProgress,
        );

        return {
          outputAssetId: outputAsset.id,
          downloadUrl: outputAsset.downloadUrl,
        };
      }

      if (job.name === "merge") {
        const outputAsset = await processMergeJob(
          redis,
          job.data.options as MergeJobOptions,
          reportProgress,
        );

        return {
          outputAssetId: outputAsset.id,
          downloadUrl: outputAsset.downloadUrl,
        };
      }

      if (job.name === "normalize") {
        const outputAsset = await processNormalizeJob(
          redis,
          job.data.options as NormalizeJobOptions,
          reportProgress,
        );

        return {
          outputAssetId: outputAsset.id,
          downloadUrl: outputAsset.downloadUrl,
        };
      }

      if (job.name === "convert-image") {
        const outputAsset = await processConvertImageJob(
          redis,
          job.data.options as ConvertImageJobOptions,
          reportProgress,
        );

        return {
          outputAssetId: outputAsset.id,
          downloadUrl: outputAsset.downloadUrl,
        };
      }

      throw new Error(`Unsupported job type "${job.name}".`);
    },
  );

  worker.on("active", (job) => {
    if (!job?.id) {
      return;
    }

    void markJobProcessing(
      redis,
      job.id,
      typeof job.progress === "undefined" ? 0 : job.progress,
    );
  });

  worker.on("progress", (job, progress) => {
    if (!job.id) {
      return;
    }

    void updateJobProgress(redis, job.id, progress);
  });

  worker.on("completed", (job, result) => {
    if (!job.id) {
      return;
    }

    void markJobCompleted(redis, job.id, result);
  });

  worker.on("failed", (job, error) => {
    if (!job?.id) {
      return;
    }

    void markJobFailed(
      redis,
      job.id,
      error.message,
      typeof job.progress === "undefined" ? null : job.progress,
    );
  });

  worker.on("error", (error) => {
    console.error("BullMQ worker error:", error);
  });

  await worker.waitUntilReady();
  console.log(options.label ?? "Video processing worker is ready.");

  return {
    worker,
    close: async () => {
      await worker.close();
      await closeRedisClient(redis);
    },
  };
}
