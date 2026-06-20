import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Redis } from "ioredis";
import { serverConfig } from "../config.js";
import type {
  JobProgress,
  MediaMetadata,
  MergeJobOptions,
  StoredMediaAsset,
  TrimJobOptions,
} from "../types.js";
import { runCommand } from "./command.js";
import { ensureStorageDirectories, getAssetOrThrow, registerOutputAsset } from "./filesystem.js";
import {
  buildTemporaryWorkingFilePath,
  cleanupTemporaryFile,
  downloadR2ObjectToLocalFile,
} from "./object-storage.js";

type ProbeResult = {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    sample_rate?: string;
    channels?: number;
  }>;
  format?: {
    format_name?: string;
    duration?: string;
    size?: string;
    bit_rate?: string;
  };
};

function parseNumber(value: string | number | undefined) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildOutputFilePath(prefix: string) {
  return path.join(serverConfig.outputsDir, `${prefix}-${randomUUID()}.mp4`);
}

function toForwardSlashPath(filePath: string) {
  return filePath.replace(/\\/g, "/");
}

function escapeConcatFilePath(filePath: string) {
  return toForwardSlashPath(filePath).replace(/'/g, "'\\''");
}

type StagedProcessingAsset = {
  localFilePath: string;
  shouldCleanup: boolean;
};

async function stageAssetForProcessing(
  asset: StoredMediaAsset,
  prefix: string,
): Promise<StagedProcessingAsset> {
  if (asset.storageDriver === "local") {
    if (!asset.filePath) {
      throw new Error(`Asset "${asset.id}" is missing its local file path.`);
    }

    return {
      localFilePath: asset.filePath,
      shouldCleanup: false,
    };
  }

  const localFilePath = buildTemporaryWorkingFilePath(prefix, asset.storedName);

  await downloadR2ObjectToLocalFile({
    objectKey: asset.storageKey,
    localFilePath,
  });

  return {
    localFilePath,
    shouldCleanup: true,
  };
}

async function cleanupStagedAssets(stagedAssets: StagedProcessingAsset[]) {
  await Promise.all(
    stagedAssets
      .filter((asset) => asset.shouldCleanup)
      .map((asset) => cleanupTemporaryFile(asset.localFilePath)),
  );
}

async function reportProgress(
  callback: ((progress: JobProgress) => Promise<void>) | undefined,
  progress: JobProgress,
) {
  if (!callback) {
    return;
  }

  await callback(progress);
}

export async function probeMedia(filePath: string): Promise<MediaMetadata | null> {
  const { stdout } = await runCommand("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as ProbeResult;
  const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audioStream = parsed.streams?.find((stream) => stream.codec_type === "audio");

  return {
    formatName: parsed.format?.format_name ?? null,
    durationSeconds: parseNumber(parsed.format?.duration),
    sizeBytes: parseNumber(parsed.format?.size),
    bitRate: parseNumber(parsed.format?.bit_rate),
    width: videoStream?.width ?? null,
    height: videoStream?.height ?? null,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
    frameRate: videoStream?.r_frame_rate ?? null,
    audioSampleRate: parseNumber(audioStream?.sample_rate),
    audioChannels: audioStream?.channels ?? null,
  };
}

function buildTrimOutputName(sourceAsset: StoredMediaAsset) {
  const extension = path.extname(sourceAsset.originalName);
  const baseName = path.basename(sourceAsset.originalName, extension) || "trimmed-video";
  return `${baseName}-trimmed.mp4`;
}

function buildMergeOutputName() {
  return `merged-${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`;
}

export async function processTrimJob(
  redis: Redis,
  options: TrimJobOptions,
  onProgress?: (progress: JobProgress) => Promise<void>,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);
  const outputFilePath = buildOutputFilePath("trimmed");
  const duration = Number((options.endTime - options.startTime).toFixed(3));
  const stagedSourceAsset = await stageAssetForProcessing(sourceAsset, "trim-sources");

  await ensureStorageDirectories();
  await reportProgress(onProgress, 10);

  try {
    await runCommand("ffmpeg", [
      "-y",
      "-ss",
      `${options.startTime}`,
      "-i",
      stagedSourceAsset.localFilePath,
      "-t",
      `${duration}`,
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      outputFilePath,
    ]);
    await reportProgress(onProgress, 85);

    const outputAsset = await registerOutputAsset(redis, {
      filePath: outputFilePath,
      originalName: buildTrimOutputName(sourceAsset),
    });

    await reportProgress(onProgress, 100);

    return outputAsset;
  } catch (error) {
    await cleanupTemporaryFile(outputFilePath);
    throw error;
  } finally {
    await cleanupTemporaryFile(
      stagedSourceAsset.shouldCleanup ? stagedSourceAsset.localFilePath : null,
    );
  }
}

export async function processMergeJob(
  redis: Redis,
  options: MergeJobOptions,
  onProgress?: (progress: JobProgress) => Promise<void>,
) {
  const sourceAssets = await Promise.all(
    options.sourceAssetIds.map((assetId) => getAssetOrThrow(redis, assetId)),
  );
  const stagedSourceAssets = await Promise.all(
    sourceAssets.map((asset) => stageAssetForProcessing(asset, "merge-sources")),
  );
  const outputFilePath = buildOutputFilePath("merged");
  const concatFilePath = path.join(serverConfig.tempDir, `merge-${randomUUID()}.txt`);

  await ensureStorageDirectories();
  await reportProgress(onProgress, 10);

  const concatFileContent = stagedSourceAssets
    .map((asset) => `file '${escapeConcatFilePath(asset.localFilePath)}'`)
    .join("\n");

  await writeFile(concatFilePath, concatFileContent, "utf8");
  await reportProgress(onProgress, 25);

  try {
    await runCommand("ffmpeg", [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatFilePath,
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      outputFilePath,
    ]);
    await reportProgress(onProgress, 85);

    const outputAsset = await registerOutputAsset(redis, {
      filePath: outputFilePath,
      originalName: buildMergeOutputName(),
    });

    await reportProgress(onProgress, 100);

    return outputAsset;
  } catch (error) {
    await cleanupTemporaryFile(outputFilePath);
    throw error;
  } finally {
    await Promise.all([
      unlink(concatFilePath).catch(() => undefined),
      cleanupStagedAssets(stagedSourceAssets),
    ]);
  }
}
