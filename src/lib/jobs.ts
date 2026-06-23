import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { serverConfig } from "../config.js";
import { resolveSupportedImageFormat } from "./asset-media.js";
import type {
  ConvertImageJobOptions,
  JobProgress,
  MergeJobOptions,
  NormalizeJobOptions,
  ProcessingJob,
  QueueJobData,
  QueueJobResult,
  StoredMediaAsset,
  TrimJobOptions,
} from "../types.js";
import { getAssetOrThrow } from "./filesystem.js";
import { getManyJsonRecords, getJsonRecord, setJsonRecord } from "./redis-records.js";
import { toJobDto } from "./serializers.js";

function getJobRecordKey(jobId: string) {
  return `${serverConfig.redisKeys.jobRecordPrefix}:${jobId}`;
}

async function persistJob(redis: Redis, job: ProcessingJob) {
  const createdAtScore = Date.parse(job.createdAt) || Date.now();

  await Promise.all([
    setJsonRecord(redis, getJobRecordKey(job.id), job),
    redis.zadd(serverConfig.redisKeys.jobIndex, createdAtScore, job.id),
  ]);
}

async function readStoredJob(redis: Redis, jobId: string) {
  return getJsonRecord<ProcessingJob>(redis, getJobRecordKey(jobId));
}

async function updateJob(
  redis: Redis,
  jobId: string,
  patch: Partial<ProcessingJob>,
) {
  const job = await readStoredJob(redis, jobId);

  if (!job) {
    throw new Error(`Job "${jobId}" was not found.`);
  }

  const updatedJob: ProcessingJob = {
    ...job,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  await setJsonRecord(redis, getJobRecordKey(jobId), updatedJob);

  return updatedJob;
}

function createQueuedJobRecord(
  type: ProcessingJob["type"],
  sourceAssetIds: string[],
  options: ProcessingJob["options"],
): ProcessingJob {
  const createdAt = new Date().toISOString();

  return {
    id: randomUUID(),
    type,
    status: "queued",
    sourceAssetIds,
    outputAssetId: null,
    downloadUrl: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
    progress: 0,
    options,
  };
}

type MergeCompatibilityCheck = {
  label: string;
  readValue: (asset: StoredMediaAsset) => string;
};

const mergeCompatibilityChecks: MergeCompatibilityCheck[] = [
  {
    label: "resolution",
    readValue: (asset) => {
      const width = asset.metadata?.width;
      const height = asset.metadata?.height;

      return width && height ? `${width}x${height}` : "unknown";
    },
  },
  {
    label: "video codec",
    readValue: (asset) => asset.metadata?.videoCodec ?? "unknown",
  },
  {
    label: "audio codec",
    readValue: (asset) => asset.metadata?.audioCodec ?? "unknown",
  },
  {
    label: "frame rate",
    readValue: (asset) => asset.metadata?.frameRate ?? "unknown",
  },
  {
    label: "audio sample rate",
    readValue: (asset) =>
      asset.metadata?.audioSampleRate ? `${asset.metadata.audioSampleRate} Hz` : "unknown",
  },
  {
    label: "audio channels",
    readValue: (asset) =>
      asset.metadata?.audioChannels ? String(asset.metadata.audioChannels) : "unknown",
  },
];

function validateMergeSourceAssets(sourceAssets: StoredMediaAsset[]) {
  const issues = mergeCompatibilityChecks.flatMap((check) => {
    const values = new Map<string, string[]>();

    for (const asset of sourceAssets) {
      const value = check.readValue(asset);
      const assetLabels = values.get(value) ?? [];
      assetLabels.push(asset.originalName);
      values.set(value, assetLabels);
    }

    if (values.size <= 1) {
      return [];
    }

    return [
      `${check.label}: ${Array.from(values.entries())
        .map(([value, assets]) => `${value} (${assets.join(", ")})`)
        .join("; ")}`,
    ];
  });

  if (issues.length === 0) {
    return;
  }

  throw new Error(
    `Merge source assets are incompatible. Normalize the clips to the same format before merging. Conflicting settings: ${issues.join(" | ")}.`,
  );
}

export async function listJobDtos(redis: Redis) {
  const jobIds = await redis.zrevrange(serverConfig.redisKeys.jobIndex, 0, -1);
  const jobs = await getManyJsonRecords<ProcessingJob>(
    redis,
    jobIds.map((jobId) => getJobRecordKey(jobId)),
  );

  return jobs.map((job) => toJobDto(job));
}

export async function getJobDto(redis: Redis, jobId: string) {
  const job = await readStoredJob(redis, jobId);

  if (!job) {
    throw new Error(`Job "${jobId}" was not found.`);
  }

  return toJobDto(job);
}

export async function createTrimJob(
  redis: Redis,
  queue: Queue<QueueJobData, QueueJobResult>,
  options: TrimJobOptions,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);
  const duration = sourceAsset.metadata?.durationSeconds;

  if (options.startTime < 0) {
    throw new Error("Trim start time must be zero or greater.");
  }

  if (options.endTime <= options.startTime) {
    throw new Error("Trim end time must be greater than start time.");
  }

  if (duration !== null && duration !== undefined && options.endTime > duration) {
    throw new Error("Trim end time cannot be greater than the source duration.");
  }

  const job = createQueuedJobRecord("trim", [options.assetId], options);
  await persistJob(redis, job);

  try {
    await queue.add(
      "trim",
      {
        jobId: job.id,
        type: "trim",
        sourceAssetIds: [options.assetId],
        options,
      },
      {
        jobId: job.id,
      },
    );
  } catch (error) {
    await markJobFailed(
      redis,
      job.id,
      error instanceof Error ? error.message : "Redis queue enqueue failed.",
      0,
    );
    throw error;
  }

  return toJobDto(job);
}

export async function createMergeJob(
  redis: Redis,
  queue: Queue<QueueJobData, QueueJobResult>,
  options: MergeJobOptions,
) {
  if (options.sourceAssetIds.length < 2) {
    throw new Error("Merge requires at least two source assets.");
  }

  const sourceAssets = await Promise.all(
    options.sourceAssetIds.map((assetId) => getAssetOrThrow(redis, assetId)),
  );
  validateMergeSourceAssets(sourceAssets);

  const sourceAssetIds = [...options.sourceAssetIds];
  const job = createQueuedJobRecord("merge", sourceAssetIds, {
    sourceAssetIds,
  });
  await persistJob(redis, job);

  try {
    await queue.add(
      "merge",
      {
        jobId: job.id,
        type: "merge",
        sourceAssetIds,
        options: {
          sourceAssetIds,
        },
      },
      {
        jobId: job.id,
      },
    );
  } catch (error) {
    await markJobFailed(
      redis,
      job.id,
      error instanceof Error ? error.message : "Redis queue enqueue failed.",
      0,
    );
    throw error;
  }

  return toJobDto(job);
}

export async function createNormalizeJob(
  redis: Redis,
  queue: Queue<QueueJobData, QueueJobResult>,
  options: NormalizeJobOptions,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);

  if (!sourceAsset.metadata?.videoCodec) {
    throw new Error("Normalize currently requires a video asset with a video stream.");
  }

  if (options.target.width % 2 !== 0 || options.target.height % 2 !== 0) {
    throw new Error("Normalize target width and height must be even numbers.");
  }

  const job = createQueuedJobRecord("normalize", [options.assetId], options);
  await persistJob(redis, job);

  try {
    await queue.add(
      "normalize",
      {
        jobId: job.id,
        type: "normalize",
        sourceAssetIds: [options.assetId],
        options,
      },
      {
        jobId: job.id,
      },
    );
  } catch (error) {
    await markJobFailed(
      redis,
      job.id,
      error instanceof Error ? error.message : "Redis queue enqueue failed.",
      0,
    );
    throw error;
  }

  return toJobDto(job);
}

export async function createConvertImageJob(
  redis: Redis,
  queue: Queue<QueueJobData, QueueJobResult>,
  options: ConvertImageJobOptions,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);
  const sourceFormat = resolveSupportedImageFormat({
    mimeType: sourceAsset.mimeType,
    fileName: sourceAsset.originalName,
  });

  if (!sourceFormat) {
    throw new Error(`Asset "${sourceAsset.id}" is not a supported image source.`);
  }

  if (
    sourceFormat === options.target.format &&
    options.target.width === undefined &&
    options.target.height === undefined
  ) {
    throw new Error(
      "Convert job would not change the file. Choose another format or resize target.",
    );
  }

  const job = createQueuedJobRecord("convert-image", [options.assetId], options);
  await persistJob(redis, job);

  try {
    await queue.add(
      "convert-image",
      {
        jobId: job.id,
        type: "convert-image",
        sourceAssetIds: [options.assetId],
        options,
      },
      {
        jobId: job.id,
      },
    );
  } catch (error) {
    await markJobFailed(
      redis,
      job.id,
      error instanceof Error ? error.message : "Redis queue enqueue failed.",
      0,
    );
    throw error;
  }

  return toJobDto(job);
}

export async function markJobProcessing(
  redis: Redis,
  jobId: string,
  progress: JobProgress = 0,
) {
  return updateJob(redis, jobId, {
    status: "processing",
    error: null,
    progress,
  });
}

export async function updateJobProgress(
  redis: Redis,
  jobId: string,
  progress: JobProgress,
) {
  return updateJob(redis, jobId, {
    progress,
  });
}

export async function markJobCompleted(
  redis: Redis,
  jobId: string,
  result: QueueJobResult,
) {
  return updateJob(redis, jobId, {
    status: "completed",
    outputAssetId: result.outputAssetId,
    downloadUrl: result.downloadUrl,
    error: null,
    progress: 100,
  });
}

export async function markJobFailed(
  redis: Redis,
  jobId: string,
  message: string,
  progress: JobProgress = null,
) {
  return updateJob(redis, jobId, {
    status: "failed",
    error: message,
    progress,
  });
}
