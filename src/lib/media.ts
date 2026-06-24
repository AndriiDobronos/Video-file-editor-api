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
  CompressVideoJobOptions,
  ConvertImageJobOptions,
  ConvertImageFit,
  ConvertImageFormat,
  CropPadAnchorX,
  CropPadAnchorY,
  CropPadJobOptions,
  ExtractFrameJobOptions,
  JobProgress,
  MediaMetadata,
  MergeJobOptions,
  NormalizeJobOptions,
  OverlayTextJobOptions,
  StoredMediaAsset,
  TextOverlayHorizontal,
  TextOverlayTarget,
  TextOverlayVertical,
  TrimJobOptions,
  VideoCompressionEncoderPreset,
  VideoCompressionPreset,
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

function buildCompressedVideoOutputName(sourceAsset: StoredMediaAsset) {
  const extension = path.extname(sourceAsset.originalName);
  const baseName = path.basename(sourceAsset.originalName, extension) || "compressed-video";
  return `${baseName}-compressed.mp4`;
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

function buildExtractFrameOutputName(
  sourceAsset: StoredMediaAsset,
  options: ExtractFrameJobOptions,
) {
  const extension = path.extname(sourceAsset.originalName);
  const baseName = path.basename(sourceAsset.originalName, extension) || "video-frame";
  const timestampLabel = options.target.timeSeconds.toFixed(2).replace(/[^\d]+/g, "-");

  return `${baseName}-frame-${timestampLabel}${getTargetImageExtension(options.target.format)}`;
}

function buildTextOverlayOutputName(sourceAsset: StoredMediaAsset) {
  const extension = path.extname(sourceAsset.originalName);
  const baseName = path.basename(sourceAsset.originalName, extension) || "text-overlay";
  return `${baseName}-text-overlay.mp4`;
}

type StillImageTargetInput = {
  format: ConvertImageFormat;
  quality?: number;
  width?: number;
  height?: number;
  fit?: ConvertImageFit;
  background?: string;
};

type CompressionProfile = {
  encoderPreset: VideoCompressionEncoderPreset;
  crf?: number;
  videoBitrateKbps?: number;
  audioBitrateKbps: number;
};

const simpleCompressionProfiles: Record<VideoCompressionPreset, CompressionProfile> = {
  "high-quality": {
    encoderPreset: "slow",
    crf: 20,
    audioBitrateKbps: 192,
  },
  balanced: {
    encoderPreset: "medium",
    crf: 24,
    audioBitrateKbps: 128,
  },
  "small-file": {
    encoderPreset: "slow",
    crf: 30,
    audioBitrateKbps: 96,
  },
};

function resolveCompressionProfile(options: CompressVideoJobOptions): CompressionProfile {
  if (options.target.mode === "simple") {
    return (
      simpleCompressionProfiles[options.target.preset ?? "balanced"] ??
      simpleCompressionProfiles.balanced
    );
  }

  return {
    encoderPreset: options.target.encoderPreset ?? "medium",
    crf: options.target.crf ?? (options.target.videoBitrateKbps ? undefined : 23),
    videoBitrateKbps: options.target.videoBitrateKbps,
    audioBitrateKbps: options.target.audioBitrateKbps ?? 128,
  };
}

function getStillImageQuality(input: { target: StillImageTargetInput }) {
  return Math.max(1, Math.min(100, Math.round(input.target.quality ?? 92)));
}

function getJpegQValue(quality: number) {
  return Math.max(2, Math.min(31, Math.round(31 - ((quality - 1) * 29) / 99)));
}

function getStillImageBackgroundColor(input: { target: StillImageTargetInput }) {
  if (input.target.background) {
    return `0x${input.target.background.replace(/^#/, "")}`;
  }

  return input.target.format === "jpeg" ? "0xFFFFFF" : "black@0";
}

function buildStillImageFilter(target: StillImageTargetInput) {
  const { width, height } = target;
  const fit = target.fit ?? "contain";
  const filters: string[] = [];

  if (width && height) {
    if (fit === "stretch") {
      filters.push(`scale=${width}:${height}`);
    } else if (fit === "cover") {
      filters.push(`scale=${width}:${height}:force_original_aspect_ratio=increase`);
      filters.push(`crop=${width}:${height}`);
    } else {
      filters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease`);
      filters.push(`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${getStillImageBackgroundColor({ target })}`);
    }
  } else if (width) {
    filters.push(`scale=${width}:-2`);
  } else if (height) {
    filters.push(`scale=-2:${height}`);
  }

  if (target.format === "jpeg") {
    filters.push("format=yuv420p");
  }

  return filters.length > 0 ? filters.join(",") : null;
}

function appendStillImageEncodingArgs(
  ffmpegArgs: string[],
  target: StillImageTargetInput,
  quality: number,
) {
  ffmpegArgs.push("-frames:v", "1");

  if (target.format === "png") {
    ffmpegArgs.push("-c:v", "png", "-update", "1");
  }

  if (target.format === "jpeg") {
    ffmpegArgs.push("-update", "1", "-q:v", `${getJpegQValue(quality)}`);
  }

  if (target.format === "webp") {
    ffmpegArgs.push("-c:v", "libwebp", "-quality", `${quality}`);
  }
}

function escapeDrawtextFilePath(filePath: string) {
  return toForwardSlashPath(filePath)
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\\\'");
}

function getTextOverlayPositionX(position: TextOverlayHorizontal | undefined) {
  if (position === "left") {
    return "40";
  }

  if (position === "right") {
    return "w-text_w-40";
  }

  return "(w-text_w)/2";
}

function getTextOverlayPositionY(position: TextOverlayVertical | undefined) {
  if (position === "top") {
    return "40";
  }

  if (position === "center") {
    return "(h-text_h)/2";
  }

  return "h-text_h-40";
}

function clampColorChannel(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function clampUnitInterval(value: number) {
  return Math.max(0, Math.min(1, value));
}

function formatTextOverlayAlpha(value: number) {
  return clampUnitInterval(value)
    .toFixed(3)
    .replace(/\.?0+$/, "");
}

function parseTextOverlayColor(color: string | undefined, fallback: string) {
  const resolvedColor = (color ?? fallback).trim();

  if (/^transparent$/i.test(resolvedColor)) {
    return {
      hex: "0x000000",
      alpha: 0,
    };
  }

  const hexMatch = resolvedColor.match(/^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/);

  if (hexMatch) {
    return {
      hex: `0x${hexMatch[1]}`,
      alpha: hexMatch[2] ? clampUnitInterval(parseInt(hexMatch[2], 16) / 255) : 1,
    };
  }

  const rgbMatch = resolvedColor.match(
    /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i,
  );

  if (rgbMatch) {
    const [, red, green, blue] = rgbMatch;
    return {
      hex: `0x${[red, green, blue]
        .map((channel) =>
          clampColorChannel(Number(channel)).toString(16).padStart(2, "0").toUpperCase(),
        )
        .join("")}`,
      alpha: 1,
    };
  }

  const rgbaMatch = resolvedColor.match(
    /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*((?:0|1(?:\.0+)?|0?\.\d+))\s*\)$/i,
  );

  if (rgbaMatch) {
    const [, red, green, blue, alphaValue] = rgbaMatch;
    return {
      hex: `0x${[red, green, blue]
        .map((channel) =>
          clampColorChannel(Number(channel)).toString(16).padStart(2, "0").toUpperCase(),
        )
        .join("")}`,
      alpha: clampUnitInterval(Number(alphaValue)),
    };
  }

  throw new Error(
    `Unsupported text overlay color "${resolvedColor}". Use hex, hex with alpha, rgb(), rgba(), or transparent.`,
  );
}

function formatTextOverlayColor(
  color: string | undefined,
  fallback: string,
) {
  const parsedColor = parseTextOverlayColor(color, fallback);

  if (parsedColor.alpha >= 1) {
    return parsedColor.hex;
  }

  return `${parsedColor.hex}@${formatTextOverlayAlpha(parsedColor.alpha)}`;
}

function buildTextOverlayEnableExpression(target: TextOverlayTarget) {
  if (
    typeof target.startTime === "number" &&
    typeof target.endTime === "number"
  ) {
    return `between(t,${target.startTime},${target.endTime})`;
  }

  if (typeof target.startTime === "number") {
    return `gte(t,${target.startTime})`;
  }

  if (typeof target.endTime === "number") {
    return `lte(t,${target.endTime})`;
  }

  return null;
}

function buildTextOverlayFilter(input: {
  textFilePath: string;
  target: TextOverlayTarget;
}) {
  const enableExpression = buildTextOverlayEnableExpression(input.target);
  const filterOptions = [
    `textfile='${escapeDrawtextFilePath(input.textFilePath)}'`,
    "reload=0",
    `fontsize=${Math.max(12, Math.round(input.target.fontSize ?? 42))}`,
    `fontcolor=${formatTextOverlayColor(input.target.fontColor, "#ffffff")}`,
    "box=1",
    `boxcolor=${formatTextOverlayColor(
      input.target.backgroundColor,
      "rgba(17, 17, 17, 0.72)",
    )}`,
    "boxborderw=18",
    `x=${getTextOverlayPositionX(input.target.horizontal)}`,
    `y=${getTextOverlayPositionY(input.target.vertical)}`,
  ];

  if (enableExpression) {
    filterOptions.push(`enable='${enableExpression}'`);
  }

  return `drawtext=${filterOptions.join(":")}`;
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

export async function processCompressVideoJob(
  redis: Redis,
  options: CompressVideoJobOptions,
  onProgress?: (progress: JobProgress) => Promise<void>,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);
  const outputFilePath = buildOutputFilePath("compressed");
  const stagedSourceAsset = await stageAssetForProcessing(
    sourceAsset,
    "compress-sources",
  );
  const compressionProfile = resolveCompressionProfile(options);

  await ensureStorageDirectories();
  await reportProgress(onProgress, 10);

  try {
    const ffmpegArgs = [
      "-y",
      "-i",
      stagedSourceAsset.localFilePath,
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      "-c:v",
      "libx264",
      "-preset",
      compressionProfile.encoderPreset,
      "-pix_fmt",
      "yuv420p",
    ];

    if (typeof compressionProfile.crf === "number") {
      ffmpegArgs.push("-crf", `${compressionProfile.crf}`);
    }

    if (compressionProfile.videoBitrateKbps) {
      ffmpegArgs.push("-b:v", `${compressionProfile.videoBitrateKbps}k`);
    }

    ffmpegArgs.push("-c:a", "aac", "-b:a", `${compressionProfile.audioBitrateKbps}k`);
    ffmpegArgs.push("-movflags", "+faststart", outputFilePath);

    await runCommand("ffmpeg", ffmpegArgs);
    await reportProgress(onProgress, 85);

    const outputAsset = await registerOutputAsset(redis, {
      filePath: outputFilePath,
      originalName: buildCompressedVideoOutputName(sourceAsset),
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
  const filter = buildStillImageFilter(options.target);
  const quality = getStillImageQuality({ target: options.target });

  await ensureStorageDirectories();
  await reportProgress(onProgress, 10);

  try {
    const ffmpegArgs = ["-y", "-i", stagedSourceAsset.localFilePath];

    if (filter) {
      ffmpegArgs.push("-vf", filter);
    }

    appendStillImageEncodingArgs(ffmpegArgs, options.target, quality);

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

export async function processExtractFrameJob(
  redis: Redis,
  options: ExtractFrameJobOptions,
  onProgress?: (progress: JobProgress) => Promise<void>,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);
  const outputFilePath = buildOutputFilePath(
    "frame",
    getTargetImageExtension(options.target.format),
  );
  const stagedSourceAsset = await stageAssetForProcessing(
    sourceAsset,
    "extract-frame-sources",
  );
  const filter = buildStillImageFilter(options.target);
  const quality = getStillImageQuality({ target: options.target });

  await ensureStorageDirectories();
  await reportProgress(onProgress, 10);

  try {
    const ffmpegArgs = [
      "-y",
      "-ss",
      `${options.target.timeSeconds}`,
      "-i",
      stagedSourceAsset.localFilePath,
    ];

    if (filter) {
      ffmpegArgs.push("-vf", filter);
    }

    appendStillImageEncodingArgs(ffmpegArgs, options.target, quality);
    ffmpegArgs.push(outputFilePath);

    await runCommand("ffmpeg", ffmpegArgs);
    await reportProgress(onProgress, 85);

    const outputAsset = await registerOutputAsset(redis, {
      filePath: outputFilePath,
      originalName: buildExtractFrameOutputName(sourceAsset, options),
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

export async function processOverlayTextJob(
  redis: Redis,
  options: OverlayTextJobOptions,
  onProgress?: (progress: JobProgress) => Promise<void>,
) {
  const sourceAsset = await getAssetOrThrow(redis, options.assetId);
  const outputFilePath = buildOutputFilePath("text-overlay");
  const stagedSourceAsset = await stageAssetForProcessing(
    sourceAsset,
    "text-overlay-sources",
  );
  const textFilePath = path.join(
    serverConfig.tempDir,
    `text-overlay-${randomUUID()}.txt`,
  );
  const filter = buildTextOverlayFilter({
    textFilePath,
    target: options.target,
  });

  await ensureStorageDirectories();
  await writeFile(textFilePath, options.target.text, "utf8");
  await reportProgress(onProgress, 10);

  try {
    await runCommand("ffmpeg", [
      "-y",
      "-i",
      stagedSourceAsset.localFilePath,
      "-vf",
      filter,
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
      outputFilePath,
    ]);
    await reportProgress(onProgress, 85);

    const outputAsset = await registerOutputAsset(redis, {
      filePath: outputFilePath,
      originalName: buildTextOverlayOutputName(sourceAsset),
    });

    await reportProgress(onProgress, 100);

    return outputAsset;
  } catch (error) {
    await cleanupTemporaryFile(outputFilePath);
    throw error;
  } finally {
    await Promise.all([
      unlink(textFilePath).catch(() => undefined),
      cleanupTemporaryFile(
        stagedSourceAsset.shouldCleanup ? stagedSourceAsset.localFilePath : null,
      ),
    ]);
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
