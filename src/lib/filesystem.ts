import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { MultipartFile } from "@fastify/multipart";
import type { Redis } from "ioredis";
import { serverConfig } from "../config.js";
import type { MediaAssetDto, MediaStorageDriver, StoredMediaAsset } from "../types.js";
import { buildAssetThumbnailUrl, isPreviewableAsset } from "./asset-media.js";
import { generateThumbnailPreview, probeMedia } from "./media.js";
import {
  buildObjectStorageKey,
  buildThumbnailStorageKey,
  buildTemporaryWorkingFilePath,
  cleanupTemporaryFile,
  downloadR2ObjectToLocalFile,
  deleteR2Object,
  ensureWorkingDirectory,
  getMediaStorageDriver,
  uploadLocalFileToR2,
} from "./object-storage.js";
import { getManyJsonRecords, getJsonRecord, setJsonRecord } from "./redis-records.js";
import { toAssetDto } from "./serializers.js";

function slugifyFileBase(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function normalizeExtension(fileName: string) {
  const extension = path.extname(fileName).toLowerCase();
  return extension || ".bin";
}

function createStoredFileName(fileName: string) {
  const extension = normalizeExtension(fileName);
  const fileBase = slugifyFileBase(path.basename(fileName, extension)) || "media";
  return `${fileBase}-${randomUUID()}${extension}`;
}

function buildThumbnailFileName(storedName: string) {
  const extensionlessName = path.basename(storedName, path.extname(storedName));
  return `${extensionlessName}.jpg`;
}

function getAssetRecordKey(assetId: string) {
  return `${serverConfig.redisKeys.assetRecordPrefix}:${assetId}`;
}

export async function ensureStorageDirectories() {
  await Promise.all(
    [
      serverConfig.storageRoot,
      serverConfig.uploadsDir,
      serverConfig.outputsDir,
      serverConfig.thumbnailsDir,
      serverConfig.tempDir,
    ].map((directory) => mkdir(directory, { recursive: true })),
  );
}

async function createStoredAssetThumbnail(input: {
  localFilePath: string;
  storedName: string;
  storageDriver: MediaStorageDriver;
  mimeType: string;
  metadata: StoredMediaAsset["metadata"];
}) {
  if (
    !isPreviewableAsset({
      mimeType: input.mimeType,
      fileName: input.storedName,
      metadata: input.metadata,
    })
  ) {
    return {
      thumbnailStorageKey: null,
      thumbnailMimeType: null,
      thumbnailFilePath: null,
    };
  }

  const thumbnailStorageKey = buildThumbnailStorageKey(input.storedName);
  const thumbnailFileName = buildThumbnailFileName(input.storedName);
  const thumbnailFilePath =
    input.storageDriver === "local"
      ? path.join(serverConfig.thumbnailsDir, thumbnailFileName)
      : buildTemporaryWorkingFilePath("asset-thumbnails", thumbnailFileName);

  try {
    await ensureWorkingDirectory(thumbnailFilePath);
    await generateThumbnailPreview(input.localFilePath, thumbnailFilePath);

    if (input.storageDriver === "r2") {
      await uploadLocalFileToR2({
        localFilePath: thumbnailFilePath,
        objectKey: thumbnailStorageKey,
        contentType: "image/jpeg",
      });
    }

    return {
      thumbnailStorageKey,
      thumbnailMimeType: "image/jpeg",
      thumbnailFilePath: input.storageDriver === "local" ? thumbnailFilePath : null,
    };
  } catch (error) {
    console.warn(
      `Thumbnail generation failed for "${input.storedName}": ${
        error instanceof Error ? error.message : "Unknown error."
      }`,
    );

    await cleanupTemporaryFile(thumbnailFilePath);

    return {
      thumbnailStorageKey: null,
      thumbnailMimeType: null,
      thumbnailFilePath: null,
    };
  } finally {
    if (input.storageDriver === "r2") {
      await cleanupTemporaryFile(thumbnailFilePath);
    }
  }
}

async function persistStoredAsset(input: {
  redis: Redis;
  localFilePath: string;
  kind: StoredMediaAsset["kind"];
  mimeType: string;
  originalName: string;
  storedName: string;
}) {
  const metadata = await probeMedia(input.localFilePath);
  const fileStats = await stat(input.localFilePath);
  const storageDriver = getMediaStorageDriver();
  const storageKey = buildObjectStorageKey(input.kind, input.storedName);

  if (storageDriver === "r2") {
    await uploadLocalFileToR2({
      localFilePath: input.localFilePath,
      objectKey: storageKey,
      contentType: input.mimeType,
    });
  }

  const thumbnail = await createStoredAssetThumbnail({
    localFilePath: input.localFilePath,
    storedName: input.storedName,
    storageDriver,
    mimeType: input.mimeType,
    metadata,
  });

  const asset: StoredMediaAsset = {
    id: randomUUID(),
    kind: input.kind,
    storageDriver,
    storageKey,
    thumbnailStorageKey: thumbnail.thumbnailStorageKey,
    originalName: input.originalName,
    storedName: input.storedName,
    mimeType: input.mimeType,
    thumbnailMimeType: thumbnail.thumbnailMimeType,
    sizeBytes: fileStats.size,
    filePath: storageDriver === "local" ? input.localFilePath : null,
    thumbnailFilePath: thumbnail.thumbnailFilePath,
    createdAt: new Date().toISOString(),
    downloadUrl: "",
    thumbnailUrl: null,
    metadata,
  };

  asset.downloadUrl = `/api/v1/assets/${asset.id}/download`;
  asset.thumbnailUrl = isPreviewableAsset({
    mimeType: asset.mimeType,
    fileName: asset.originalName,
    metadata: asset.metadata,
  })
    ? buildAssetThumbnailUrl(asset.id)
    : null;
  const createdAtScore = Date.parse(asset.createdAt) || Date.now();

  await Promise.all([
    setJsonRecord(input.redis, getAssetRecordKey(asset.id), asset),
    input.redis.zadd(serverConfig.redisKeys.assetIndex, createdAtScore, asset.id),
  ]);

  return asset;
}

export async function saveIncomingUpload(
  redis: Redis,
  part: MultipartFile,
): Promise<StoredMediaAsset> {
  await ensureStorageDirectories();

  if (!part.filename) {
    throw new Error("Uploaded file is missing a filename.");
  }

  const storedName = createStoredFileName(part.filename);
  const storageDriver = getMediaStorageDriver();
  const localFilePath =
    storageDriver === "local"
      ? path.join(serverConfig.uploadsDir, storedName)
      : buildTemporaryWorkingFilePath("incoming-uploads", storedName);

  await ensureWorkingDirectory(localFilePath);

  await pipeline(part.file, createWriteStream(localFilePath));

  try {
    return await persistStoredAsset({
      redis,
      localFilePath,
      kind: "upload",
      mimeType: part.mimetype || "application/octet-stream",
      originalName: part.filename,
      storedName,
    });
  } finally {
    if (storageDriver === "r2") {
      await cleanupTemporaryFile(localFilePath);
    }
  }
}

export async function registerOutputAsset(
  redis: Redis,
  input: {
    filePath: string;
    originalName: string;
    mimeType?: string;
  },
) {
  const storageDriver = getMediaStorageDriver();

  try {
    return await persistStoredAsset({
      redis,
      localFilePath: input.filePath,
      kind: "output",
      mimeType: input.mimeType ?? "video/mp4",
      originalName: input.originalName,
      storedName: path.basename(input.filePath),
    });
  } finally {
    if (storageDriver === "r2") {
      await cleanupTemporaryFile(input.filePath);
    }
  }
}

export async function getAssetOrThrow(redis: Redis, assetId: string) {
  const asset = await getJsonRecord<StoredMediaAsset>(redis, getAssetRecordKey(assetId));

  if (!asset) {
    throw new Error(`Asset "${assetId}" was not found.`);
  }

  return asset;
}

export async function ensureAssetThumbnail(
  redis: Redis,
  asset: StoredMediaAsset,
): Promise<StoredMediaAsset> {
  if (
    !isPreviewableAsset({
      mimeType: asset.mimeType,
      fileName: asset.originalName,
      metadata: asset.metadata,
    })
  ) {
    return asset;
  }

  if (asset.thumbnailMimeType && (asset.thumbnailStorageKey || asset.thumbnailFilePath)) {
    if (asset.thumbnailUrl) {
      return asset;
    }

    const assetWithRoute: StoredMediaAsset = {
      ...asset,
      thumbnailUrl: buildAssetThumbnailUrl(asset.id),
    };

    await setJsonRecord(redis, getAssetRecordKey(asset.id), assetWithRoute);
    return assetWithRoute;
  }

  const stagedOriginalFilePath =
    asset.storageDriver === "local"
      ? asset.filePath
      : buildTemporaryWorkingFilePath("asset-thumbnail-sources", asset.storedName);

  if (!stagedOriginalFilePath) {
    throw new Error(`Asset "${asset.id}" is missing its local file path.`);
  }

  if (asset.storageDriver === "r2") {
    await downloadR2ObjectToLocalFile({
      objectKey: asset.storageKey,
      localFilePath: stagedOriginalFilePath,
    });
  }

  try {
    const thumbnail = await createStoredAssetThumbnail({
      localFilePath: stagedOriginalFilePath,
      storedName: asset.storedName,
      storageDriver: asset.storageDriver,
      mimeType: asset.mimeType,
      metadata: asset.metadata,
    });

    if (!thumbnail.thumbnailMimeType || (!thumbnail.thumbnailStorageKey && !thumbnail.thumbnailFilePath)) {
      return asset;
    }

    const nextAsset: StoredMediaAsset = {
      ...asset,
      thumbnailStorageKey: thumbnail.thumbnailStorageKey,
      thumbnailMimeType: thumbnail.thumbnailMimeType,
      thumbnailFilePath: thumbnail.thumbnailFilePath,
      thumbnailUrl: buildAssetThumbnailUrl(asset.id),
    };

    await setJsonRecord(redis, getAssetRecordKey(asset.id), nextAsset);
    return nextAsset;
  } finally {
    if (asset.storageDriver === "r2") {
      await cleanupTemporaryFile(stagedOriginalFilePath);
    }
  }
}

export async function regenerateAssetThumbnail(
  redis: Redis,
  assetId: string,
): Promise<StoredMediaAsset> {
  const asset = await getAssetOrThrow(redis, assetId);

  if (
    !isPreviewableAsset({
      mimeType: asset.mimeType,
      fileName: asset.originalName,
      metadata: asset.metadata,
    })
  ) {
    throw new Error(
      `Asset "${asset.originalName}" does not support thumbnail previews.`,
    );
  }

  const stagedOriginalFilePath =
    asset.storageDriver === "local"
      ? asset.filePath
      : buildTemporaryWorkingFilePath("asset-thumbnail-regenerate", asset.storedName);

  if (!stagedOriginalFilePath) {
    throw new Error(`Asset "${asset.id}" is missing its local file path.`);
  }

  if (asset.storageDriver === "r2") {
    await downloadR2ObjectToLocalFile({
      objectKey: asset.storageKey,
      localFilePath: stagedOriginalFilePath,
    });
  }

  try {
    const thumbnail = await createStoredAssetThumbnail({
      localFilePath: stagedOriginalFilePath,
      storedName: asset.storedName,
      storageDriver: asset.storageDriver,
      mimeType: asset.mimeType,
      metadata: asset.metadata,
    });

    if (
      !thumbnail.thumbnailMimeType ||
      (!thumbnail.thumbnailStorageKey && !thumbnail.thumbnailFilePath)
    ) {
      throw new Error(`Thumbnail preview could not be regenerated for "${asset.originalName}".`);
    }

    const nextAsset: StoredMediaAsset = {
      ...asset,
      thumbnailStorageKey: thumbnail.thumbnailStorageKey,
      thumbnailMimeType: thumbnail.thumbnailMimeType,
      thumbnailFilePath: thumbnail.thumbnailFilePath,
      thumbnailUrl: buildAssetThumbnailUrl(asset.id),
    };

    await setJsonRecord(redis, getAssetRecordKey(asset.id), nextAsset);
    return nextAsset;
  } finally {
    if (asset.storageDriver === "r2") {
      await cleanupTemporaryFile(stagedOriginalFilePath);
    }
  }
}

export async function listAssetDtos(redis: Redis): Promise<MediaAssetDto[]> {
  const assetIds = await redis.zrevrange(serverConfig.redisKeys.assetIndex, 0, -1);
  const assets = await getManyJsonRecords<StoredMediaAsset>(
    redis,
    assetIds.map((assetId) => getAssetRecordKey(assetId)),
  );

  return assets.map((asset) => toAssetDto(asset));
}

export async function getAssetDto(redis: Redis, assetId: string) {
  const asset = await getAssetOrThrow(redis, assetId);
  return toAssetDto(asset);
}

export async function deleteAsset(redis: Redis, assetId: string) {
  const asset = await getAssetOrThrow(redis, assetId);

  if (asset.storageDriver === "r2") {
    await Promise.all([
      deleteR2Object(asset.storageKey),
      asset.thumbnailStorageKey ? deleteR2Object(asset.thumbnailStorageKey) : Promise.resolve(),
    ]);
  } else {
    await Promise.all([
      cleanupTemporaryFile(asset.filePath),
      cleanupTemporaryFile(asset.thumbnailFilePath ?? null),
    ]);
  }

  await Promise.all([
    redis.del(getAssetRecordKey(assetId)),
    redis.zrem(serverConfig.redisKeys.assetIndex, assetId),
  ]);

  return toAssetDto(asset);
}
