import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { MultipartFile } from "@fastify/multipart";
import type { Redis } from "ioredis";
import { serverConfig } from "../config.js";
import type { MediaAssetDto, StoredMediaAsset } from "../types.js";
import { probeMedia } from "./media.js";
import {
  buildObjectStorageKey,
  buildTemporaryWorkingFilePath,
  cleanupTemporaryFile,
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

function getAssetRecordKey(assetId: string) {
  return `${serverConfig.redisKeys.assetRecordPrefix}:${assetId}`;
}

export async function ensureStorageDirectories() {
  await Promise.all(
    [
      serverConfig.storageRoot,
      serverConfig.uploadsDir,
      serverConfig.outputsDir,
      serverConfig.tempDir,
    ].map((directory) => mkdir(directory, { recursive: true })),
  );
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

  const asset: StoredMediaAsset = {
    id: randomUUID(),
    kind: input.kind,
    storageDriver,
    storageKey,
    originalName: input.originalName,
    storedName: input.storedName,
    mimeType: input.mimeType,
    sizeBytes: fileStats.size,
    filePath: storageDriver === "local" ? input.localFilePath : null,
    createdAt: new Date().toISOString(),
    downloadUrl: "",
    metadata,
  };

  asset.downloadUrl = `/api/v1/assets/${asset.id}/download`;
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
    await deleteR2Object(asset.storageKey);
  } else {
    await cleanupTemporaryFile(asset.filePath);
  }

  await Promise.all([
    redis.del(getAssetRecordKey(assetId)),
    redis.zrem(serverConfig.redisKeys.assetIndex, assetId),
  ]);

  return toAssetDto(asset);
}
