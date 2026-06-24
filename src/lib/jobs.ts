import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { serverConfig } from "../config.js";
import {
  isSupportedImageAssetLike,
  isVideoAssetLike,
  resolveSupportedImageFormat,
} from "./asset-media.js";
import type {
  AnimationExportJobOptions,
  AudioVolumeJobOptions,
  ChangeSpeedJobOptions,
  CompressVideoJobOptions,
  ConvertImageJobOptions,
  CropPadJobOptions,
  EditAudioTrackJobOptions,
  ExtractAudioJobOptions,
  ExtractFrameJobOptions,
  JobProgress,
  MergeJobOptions,
  NormalizeJobOptions,
  OverlayTextJobOptions,
  ProcessingJob,
  QueueJobData,
  QueueJobResult,
  StoredMediaAsset,
  TransitionMergeJobOptions,
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

const maxAnimationExportDurationSeconds = 15;

function isVideoStoredAsset(asset: StoredMediaAsset) {
  return Boolean(asset.metadata?.videoCodec) || isVideoAssetLike({ mimeType: asset.mimeType });
}

function hasAudioStream(asset: StoredMediaAsset) {
  return Boolean(asset.metadata?.audioCodec) || asset.mimeType.toLowerCase().startsWith("audio/");
}

function isTimedMediaAsset(asset: StoredMediaAsset) {
  return isVideoStoredAsset(asset) || hasAudioStream(asset);
}

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

function validateTransitionSourceAssets(
  sourceAssets: StoredMediaAsset[],
  options: TransitionMergeJobOptions,
) {
  if (sourceAssets.length !== 2) {
    throw new Error("Transition merge currently requires exactly two source clips.");
  }

  for (const asset of sourceAssets) {
    if (!isVideoStoredAsset(asset)) {
      throw new Error("Transition merge currently requires video clips only.");
    }

    if (
      asset.metadata?.durationSeconds === null ||
      asset.metadata?.durationSeconds === undefined
    ) {
      throw new Error(
        `Clip "${asset.originalName}" is missing duration metadata. Re-upload it before transition merge.`,
      );
    }
  }

  const minDuration = Math.min(
    sourceAssets[0].metadata?.durationSeconds ?? 0,
    sourceAssets[1].metadata?.durationSeconds ?? 0,
  );

  if (options.target.overlapSeconds <= 0) {
    throw new Error("Transition overlap must be greater than zero.");
  }

  if (options.target.overlapSeconds >= minDuration) {
    throw new Error("Transition overlap must stay shorter than the shortest selected clip.");
  }

  const transitionCompatibilityLabels = new Set([
    "resolution",
    "frame rate",
    "audio sample rate",
    "audio channels",
  ]);
  const issues = mergeCompatibilityChecks
    .filter((check) => transitionCompatibilityLabels.has(check.label))
    .flatMap((check) => {
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

  if (issues.length > 0) {
    throw new Error(
      `Transition merge source assets are incompatible. Normalize the clips to the same format before adding an overlap transition. Conflicting settings: ${issues.join(" | ")}.`,
    );
  }
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

export async function createTransitionMergeJob(
  redis: Redis,
  queue: Queue<QueueJobData, QueueJobResult>,
  options: TransitionMergeJobOptions,
) {
  const uniqueAssetIds = new Set(options.sourceAssetIds);

  if (uniqueAssetIds.size !== 2) {
    throw new Error("Choose two different clips before queueing a transition merge.");
  }

  const sourceAssets = await Promise.all(
    options.sourceAssetIds.map((assetId) => getAssetOrThrow(redis, assetId)),
  );
  validateTransitionSourceAssets(sourceAssets, options);

  const sourceAssetIds = [...options.sourceAssetIds] as [string, string];
  const job = createQueuedJobRecord("transition-merge", [...sourceAssetIds], {
    sourceAssetIds,
    target: options.target,
  });
  await persistJob(redis, job);

  try {
    await queue.add(
      "transition-merge",
      {
        jobId: job.id,
        type: "transition-merge",
        sourceAssetIds: [...sourceAssetIds],
        options: {
          sourceAssetIds,
          target: options.target,
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

export async function createCompressVideoJob(
  redis: Redis,
  queue: Queue<QueueJobData, QueueJobResult>,
  options: CompressVideoJobOptions,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);

  if (!sourceAsset.metadata?.videoCodec) {
    throw new Error("Compression currently requires a video asset with a video stream.");
  }

  const job = createQueuedJobRecord("compress-video", [options.assetId], options);
  await persistJob(redis, job);

  try {
    await queue.add(
      "compress-video",
      {
        jobId: job.id,
        type: "compress-video",
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

export async function createAnimationExportJob(
  redis: Redis,
  queue: Queue<QueueJobData, QueueJobResult>,
  options: AnimationExportJobOptions,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);
  const duration = sourceAsset.metadata?.durationSeconds;

  if (!isVideoStoredAsset(sourceAsset)) {
    throw new Error("GIF / WebP export currently requires a video source.");
  }

  if (typeof duration !== "number") {
    throw new Error("GIF / WebP export requires source duration metadata. Re-upload the clip if needed.");
  }

  if (options.target.startTime > duration) {
    throw new Error("Animation export start time cannot be greater than the source duration.");
  }

  if (options.target.durationSeconds > maxAnimationExportDurationSeconds) {
    throw new Error(
      `Animation export duration must stay at or below ${maxAnimationExportDurationSeconds} seconds.`,
    );
  }

  if (options.target.startTime + options.target.durationSeconds > duration) {
    throw new Error("Animation export range cannot extend past the end of the source clip.");
  }

  const job = createQueuedJobRecord("export-animation", [options.assetId], options);
  await persistJob(redis, job);

  try {
    await queue.add(
      "export-animation",
      {
        jobId: job.id,
        type: "export-animation",
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

export async function createExtractFrameJob(
  redis: Redis,
  queue: Queue<QueueJobData, QueueJobResult>,
  options: ExtractFrameJobOptions,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);
  const duration = sourceAsset.metadata?.durationSeconds;

  if (!sourceAsset.metadata?.videoCodec) {
    throw new Error("Frame extraction currently requires a video asset.");
  }

  if (options.target.timeSeconds < 0) {
    throw new Error("Frame extraction time must be zero or greater.");
  }

  if (
    duration !== null &&
    duration !== undefined &&
    options.target.timeSeconds > duration
  ) {
    throw new Error("Frame extraction time cannot be greater than the source duration.");
  }

  const job = createQueuedJobRecord("extract-frame", [options.assetId], options);
  await persistJob(redis, job);

  try {
    await queue.add(
      "extract-frame",
      {
        jobId: job.id,
        type: "extract-frame",
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

export async function createExtractAudioJob(
  redis: Redis,
  queue: Queue<QueueJobData, QueueJobResult>,
  options: ExtractAudioJobOptions,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);

  if (!isVideoStoredAsset(sourceAsset)) {
    throw new Error("Audio extraction currently requires a video source.");
  }

  if (!hasAudioStream(sourceAsset)) {
    throw new Error("The selected video does not contain an audio track to extract.");
  }

  const job = createQueuedJobRecord("extract-audio", [options.assetId], options);
  await persistJob(redis, job);

  try {
    await queue.add(
      "extract-audio",
      {
        jobId: job.id,
        type: "extract-audio",
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

export async function createEditAudioTrackJob(
  redis: Redis,
  queue: Queue<QueueJobData, QueueJobResult>,
  options: EditAudioTrackJobOptions,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);

  if (!isVideoStoredAsset(sourceAsset)) {
    throw new Error("Mute / replace audio currently requires a video source.");
  }

  if (options.target.mode === "mute") {
    const job = createQueuedJobRecord("edit-audio-track", [options.assetId], options);
    await persistJob(redis, job);

    try {
      await queue.add(
        "edit-audio-track",
        {
          jobId: job.id,
          type: "edit-audio-track",
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

  if (!options.target.replacementAssetId) {
    throw new Error("Choose a replacement audio source before queueing the job.");
  }

  const replacementAsset = await getAssetOrThrow(redis, options.target.replacementAssetId);

  if (!hasAudioStream(replacementAsset)) {
    throw new Error("The selected replacement file does not contain an audio stream.");
  }

  const sourceAssetIds = [options.assetId, options.target.replacementAssetId];
  const job = createQueuedJobRecord("edit-audio-track", sourceAssetIds, options);
  await persistJob(redis, job);

  try {
    await queue.add(
      "edit-audio-track",
      {
        jobId: job.id,
        type: "edit-audio-track",
        sourceAssetIds,
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

export async function createChangeSpeedJob(
  redis: Redis,
  queue: Queue<QueueJobData, QueueJobResult>,
  options: ChangeSpeedJobOptions,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);

  if (!isTimedMediaAsset(sourceAsset)) {
    throw new Error("Speed change currently supports video files and audio files only.");
  }

  if (options.target.rate < 0.25 || options.target.rate > 4) {
    throw new Error("Speed change rate must stay between 0.25x and 4x.");
  }

  const job = createQueuedJobRecord("change-speed", [options.assetId], options);
  await persistJob(redis, job);

  try {
    await queue.add(
      "change-speed",
      {
        jobId: job.id,
        type: "change-speed",
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

export async function createAudioVolumeJob(
  redis: Redis,
  queue: Queue<QueueJobData, QueueJobResult>,
  options: AudioVolumeJobOptions,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);
  const duration = sourceAsset.metadata?.durationSeconds;

  if (!hasAudioStream(sourceAsset)) {
    throw new Error("Audio volume currently requires a file that already contains audio.");
  }

  if (options.target.mute !== true) {
    if (typeof options.target.gainDb !== "number") {
      throw new Error("Choose a gain value in dB or use mute before queueing the job.");
    }

    if (options.target.gainDb < -30 || options.target.gainDb > 20) {
      throw new Error("Audio gain must stay between -30 dB and +20 dB.");
    }
  }

  const hasStartTime = typeof options.target.startTime === "number";
  const hasEndTime = typeof options.target.endTime === "number";

  if (hasStartTime !== hasEndTime) {
    throw new Error("Custom audio volume ranges require both a start time and an end time.");
  }

  if (hasStartTime && hasEndTime) {
    if ((options.target.startTime ?? 0) < 0) {
      throw new Error("Audio volume start time must be zero or greater.");
    }

    if ((options.target.endTime ?? 0) <= (options.target.startTime ?? 0)) {
      throw new Error("Audio volume end time must be greater than the start time.");
    }

    if (
      typeof duration === "number" &&
      (options.target.startTime ?? 0) > duration
    ) {
      throw new Error("Audio volume start time cannot be greater than the source duration.");
    }

    if (
      typeof duration === "number" &&
      (options.target.endTime ?? 0) > duration
    ) {
      throw new Error("Audio volume end time cannot be greater than the source duration.");
    }
  }

  const job = createQueuedJobRecord("audio-volume", [options.assetId], options);
  await persistJob(redis, job);

  try {
    await queue.add(
      "audio-volume",
      {
        jobId: job.id,
        type: "audio-volume",
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

export async function createOverlayTextJob(
  redis: Redis,
  queue: Queue<QueueJobData, QueueJobResult>,
  options: OverlayTextJobOptions,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);
  const duration = sourceAsset.metadata?.durationSeconds;
  const overlayText = options.target.text.trim();

  if (!sourceAsset.metadata?.videoCodec) {
    throw new Error("Text overlay currently requires a video asset with a video stream.");
  }

  if (!overlayText) {
    throw new Error("Text overlay requires some text before queueing the job.");
  }

  if (
    typeof options.target.startTime === "number" &&
    typeof duration === "number" &&
    options.target.startTime > duration
  ) {
    throw new Error("Text overlay start time cannot be greater than the source duration.");
  }

  if (
    typeof options.target.endTime === "number" &&
    typeof duration === "number" &&
    options.target.endTime > duration
  ) {
    throw new Error("Text overlay end time cannot be greater than the source duration.");
  }

  if (
    typeof options.target.startTime === "number" &&
    typeof options.target.endTime === "number" &&
    options.target.endTime <= options.target.startTime
  ) {
    throw new Error("Text overlay end time must be greater than the start time.");
  }

  const jobOptions: OverlayTextJobOptions = {
    ...options,
    target: {
      ...options.target,
      text: overlayText,
    },
  };

  const job = createQueuedJobRecord("overlay-text", [options.assetId], jobOptions);
  await persistJob(redis, job);

  try {
    await queue.add(
      "overlay-text",
      {
        jobId: job.id,
        type: "overlay-text",
        sourceAssetIds: [options.assetId],
        options: jobOptions,
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

export async function createCropPadJob(
  redis: Redis,
  queue: Queue<QueueJobData, QueueJobResult>,
  options: CropPadJobOptions,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);
  const isVideoSource = isVideoAssetLike({
    mimeType: sourceAsset.mimeType,
  });
  const isSupportedImageSource = isSupportedImageAssetLike({
    mimeType: sourceAsset.mimeType,
    fileName: sourceAsset.originalName,
  });
  const sourceWidth = sourceAsset.metadata?.width;
  const sourceHeight = sourceAsset.metadata?.height;

  if (!isVideoSource && !isSupportedImageSource) {
    throw new Error(
      "Crop / pad currently supports video files and PNG, JPEG, or WebP images only.",
    );
  }

  if (!sourceWidth || !sourceHeight) {
    throw new Error(
      "Crop / pad requires width and height metadata on the selected source file.",
    );
  }

  if (isVideoSource && (options.target.width % 2 !== 0 || options.target.height % 2 !== 0)) {
    throw new Error("Video crop / pad targets must use even width and height values.");
  }

  if (options.target.width === sourceWidth && options.target.height === sourceHeight) {
    throw new Error(
      "Crop / pad target matches the source dimensions. Change at least one size value.",
    );
  }

  if (
    options.target.mode === "crop" &&
    (options.target.width > sourceWidth || options.target.height > sourceHeight)
  ) {
    throw new Error("Crop target cannot be larger than the source frame.");
  }

  if (
    options.target.mode === "pad" &&
    (options.target.width < sourceWidth || options.target.height < sourceHeight)
  ) {
    throw new Error("Pad target cannot be smaller than the source frame.");
  }

  const job = createQueuedJobRecord("crop-pad", [options.assetId], options);
  await persistJob(redis, job);

  try {
    await queue.add(
      "crop-pad",
      {
        jobId: job.id,
        type: "crop-pad",
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
