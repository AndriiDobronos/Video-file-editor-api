import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { serverConfig } from "../config.js";
import type {
  JobProgress,
  MergeJobOptions,
  ProcessingJob,
  QueueJobData,
  QueueJobResult,
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

  await Promise.all(
    options.sourceAssetIds.map((assetId) => getAssetOrThrow(redis, assetId)),
  );

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
