import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Redis } from "ioredis";
import { serverConfig } from "../config.js";
import {
  getTargetImageExtension,
  getTargetImageMimeType,
  isVideoAssetLike,
  resolveSupportedImageFormat,
  type SupportedImageFormat,
} from "./asset-media.js";
import type {
  ConvertImageJobOptions,
  CropPadAnchorX,
  CropPadAnchorY,
  CropPadJobOptions,
  JobProgress,
  MediaMetadata,
  MergeJobOptions,
  NormalizeJobOptions,
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

function buildOutputFilePath(prefix: string, extension = ".mp4") {
  return path.join(serverConfig.outputsDir, `${prefix}-${randomUUID()}${extension}`);
}

export async function generateThumbnailPreview(
  inputFilePath: string,
  outputFilePath: string,
) {
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    inputFilePath,
    "-vf",
    "thumbnail,scale='min(320,iw)':-2",
    "-frames:v",
    "1",
    "-update",
    "1",
    "-q:v",
    "3",
    outputFilePath,
  ]);
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

function buildNormalizedOutputName(
  sourceAsset: StoredMediaAsset,
  options: NormalizeJobOptions,
) {
  const extension = path.extname(sourceAsset.originalName);
  const baseName = path.basename(sourceAsset.originalName, extension) || "normalized-video";
  return `${baseName}-normalized-${options.target.width}x${options.target.height}.mp4`;
}

function buildConvertedImageOutputName(
  sourceAsset: StoredMediaAsset,
  options: ConvertImageJobOptions,
) {
  const extension = path.extname(sourceAsset.originalName);
  const baseName = path.basename(sourceAsset.originalName, extension) || "converted-image";

  return `${baseName}-converted${getTargetImageExtension(options.target.format)}`;
}

function buildCropPadOutputName(
  sourceAsset: StoredMediaAsset,
  options: CropPadJobOptions,
  extension: string,
) {
  const sourceExtension = path.extname(sourceAsset.originalName);
  const baseName = path.basename(sourceAsset.originalName, sourceExtension) || "edited-media";

  return `${baseName}-${options.target.mode}-${options.target.width}x${options.target.height}${extension}`;
}

function getConvertImageQuality(options: ConvertImageJobOptions) {
  return Math.max(1, Math.min(100, Math.round(options.target.quality ?? 92)));
}

function getJpegQValue(quality: number) {
  return Math.max(2, Math.min(31, Math.round(31 - ((quality - 1) * 29) / 99)));
}

function getFilterBackgroundColor(options: ConvertImageJobOptions) {
  if (options.target.background) {
    return `0x${options.target.background.replace(/^#/, "")}`;
  }

  return options.target.format === "jpeg" ? "0xFFFFFF" : "black@0";
}

function buildConvertImageFilter(options: ConvertImageJobOptions) {
  const { width, height } = options.target;
  const fit = options.target.fit ?? "contain";
  const filters: string[] = [];

  if (width && height) {
    if (fit === "stretch") {
      filters.push(`scale=${width}:${height}`);
    } else if (fit === "cover") {
      filters.push(`scale=${width}:${height}:force_original_aspect_ratio=increase`);
      filters.push(`crop=${width}:${height}`);
    } else {
      filters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`);
      filters.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${getFilterBackgroundColor(options)}`);
    }
  } else if (width) {
    filters.push(`scale=${width}:-2`);
  } else if (height) {
    filters.push(`scale=-2:${height}`);
  }

  if (options.target.format === "jpeg") {
    filters.push("format=yuv420p");
  }

  return filters.length > 0 ? filters.join(",") : null;
}

function getCropOffsetExpression(
  anchor: CropPadAnchorX | CropPadAnchorY | undefined,
  inputAxis: "iw" | "ih",
  targetSize: number,
) {
  if (anchor === "left" || anchor === "top") {
    return "0";
  }

  if (anchor === "right" || anchor === "bottom") {
    return `${inputAxis}-${targetSize}`;
  }

  return `(${inputAxis}-${targetSize})/2`;
}

function getPadOffsetExpression(
  anchor: CropPadAnchorX | CropPadAnchorY | undefined,
  outputAxis: "ow" | "oh",
  inputAxis: "iw" | "ih",
) {
  if (anchor === "left" || anchor === "top") {
    return "0";
  }

  if (anchor === "right" || anchor === "bottom") {
    return `${outputAxis}-${inputAxis}`;
  }

  return `(${outputAxis}-${inputAxis})/2`;
}

function getCropPadBackgroundColor(input: {
  sourceAsset: StoredMediaAsset;
  sourceImageFormat: SupportedImageFormat | null;
  options: CropPadJobOptions;
}) {
  if (input.options.target.background) {
    return `0x${input.options.target.background.replace(/^#/, "")}`;
  }

  if (isVideoAssetLike({ mimeType: input.sourceAsset.mimeType })) {
    return "black";
  }

  return input.sourceImageFormat === "jpeg" ? "0xFFFFFF" : "black@0";
}

function buildCropPadFilter(input: {
  sourceAsset: StoredMediaAsset;
  sourceImageFormat: SupportedImageFormat | null;
  options: CropPadJobOptions;
}) {
  const { options } = input;
  const xAnchor = options.target.anchorX ?? "center";
  const yAnchor = options.target.anchorY ?? "center";

  if (options.target.mode === "crop") {
    return [
      `crop=${options.target.width}:${options.target.height}:` +
        `${getCropOffsetExpression(xAnchor, "iw", options.target.width)}:` +
        `${getCropOffsetExpression(yAnchor, "ih", options.target.height)}`,
    ].join(",");
  }

  return [
    `pad=${options.target.width}:${options.target.height}:` +
      `${getPadOffsetExpression(xAnchor, "ow", "iw")}:` +
      `${getPadOffsetExpression(yAnchor, "oh", "ih")}:` +
      `color=${getCropPadBackgroundColor(input)}`,
  ].join(",");
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

export async function processNormalizeJob(
  redis: Redis,
  options: NormalizeJobOptions,
  onProgress?: (progress: JobProgress) => Promise<void>,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);
  const outputFilePath = buildOutputFilePath("normalized");
  const stagedSourceAsset = await stageAssetForProcessing(
    sourceAsset,
    "normalize-sources",
  );
  const scaleFilter =
    `scale=${options.target.width}:${options.target.height}:force_original_aspect_ratio=decrease,` +
    `pad=${options.target.width}:${options.target.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

  await ensureStorageDirectories();
  await reportProgress(onProgress, 10);

  try {
    await runCommand("ffmpeg", [
      "-y",
      "-i",
      stagedSourceAsset.localFilePath,
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      "-vf",
      scaleFilter,
      "-r",
      `${options.target.frameRate}`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-ar",
      `${options.target.audioSampleRate}`,
      "-ac",
      `${options.target.audioChannels}`,
      "-movflags",
      "+faststart",
      outputFilePath,
    ]);
    await reportProgress(onProgress, 85);

    const outputAsset = await registerOutputAsset(redis, {
      filePath: outputFilePath,
      originalName: buildNormalizedOutputName(sourceAsset, options),
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

export async function processConvertImageJob(
  redis: Redis,
  options: ConvertImageJobOptions,
  onProgress?: (progress: JobProgress) => Promise<void>,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);
  const outputFilePath = buildOutputFilePath(
    "converted-image",
    getTargetImageExtension(options.target.format),
  );
  const stagedSourceAsset = await stageAssetForProcessing(
    sourceAsset,
    "convert-image-sources",
  );
  const filter = buildConvertImageFilter(options);
  const quality = getConvertImageQuality(options);

  await ensureStorageDirectories();
  await reportProgress(onProgress, 10);

  try {
    const ffmpegArgs = ["-y", "-i", stagedSourceAsset.localFilePath];

    if (filter) {
      ffmpegArgs.push("-vf", filter);
    }

    ffmpegArgs.push("-frames:v", "1");

    if (options.target.format === "png") {
      ffmpegArgs.push("-c:v", "png", "-update", "1");
    }

    if (options.target.format === "jpeg") {
      ffmpegArgs.push("-update", "1", "-q:v", `${getJpegQValue(quality)}`);
    }

    if (options.target.format === "webp") {
      ffmpegArgs.push("-c:v", "libwebp", "-quality", `${quality}`);
    }

    ffmpegArgs.push(outputFilePath);

    await runCommand("ffmpeg", ffmpegArgs);
    await reportProgress(onProgress, 85);

    const outputAsset = await registerOutputAsset(redis, {
      filePath: outputFilePath,
      originalName: buildConvertedImageOutputName(sourceAsset, options),
      mimeType: getTargetImageMimeType(options.target.format),
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

export async function processCropPadJob(
  redis: Redis,
  options: CropPadJobOptions,
  onProgress?: (progress: JobProgress) => Promise<void>,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);
  const sourceImageFormat = resolveSupportedImageFormat({
    mimeType: sourceAsset.mimeType,
    fileName: sourceAsset.originalName,
  });
  const isVideoSource = isVideoAssetLike({
    mimeType: sourceAsset.mimeType,
  });

  if (!isVideoSource && !sourceImageFormat) {
    throw new Error(
      "Crop / pad currently supports video files and PNG, JPEG, or WebP images only.",
    );
  }

  const resolvedImageFormat = sourceImageFormat as SupportedImageFormat | null;
  const outputExtension = isVideoSource
    ? ".mp4"
    : getTargetImageExtension(resolvedImageFormat!);
  const outputFilePath = buildOutputFilePath("crop-pad", outputExtension);
  const stagedSourceAsset = await stageAssetForProcessing(
    sourceAsset,
    "crop-pad-sources",
  );
  const filter = buildCropPadFilter({
    sourceAsset,
    sourceImageFormat: resolvedImageFormat,
    options,
  });

  await ensureStorageDirectories();
  await reportProgress(onProgress, 10);

  try {
    const ffmpegArgs = ["-y", "-i", stagedSourceAsset.localFilePath, "-vf", filter];

    if (isVideoSource) {
      ffmpegArgs.push(
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
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
      );
    } else {
      ffmpegArgs.push("-frames:v", "1");

      if (resolvedImageFormat === "png") {
        ffmpegArgs.push("-c:v", "png", "-update", "1");
      }

      if (resolvedImageFormat === "jpeg") {
        ffmpegArgs.push("-update", "1", "-q:v", "3");
      }

      if (resolvedImageFormat === "webp") {
        ffmpegArgs.push("-c:v", "libwebp", "-quality", "92");
      }
    }

    ffmpegArgs.push(outputFilePath);

    await runCommand("ffmpeg", ffmpegArgs);
    await reportProgress(onProgress, 85);

    const outputAsset = await registerOutputAsset(redis, {
      filePath: outputFilePath,
      originalName: buildCropPadOutputName(sourceAsset, options, outputExtension),
      mimeType:
        isVideoSource || !resolvedImageFormat
          ? undefined
          : getTargetImageMimeType(resolvedImageFormat),
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
