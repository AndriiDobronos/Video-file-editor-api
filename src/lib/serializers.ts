import type { MediaAssetDto, ProcessingJob, StoredMediaAsset } from "../types.js";

export function toAssetDto(asset: StoredMediaAsset): MediaAssetDto {
  return {
    id: asset.id,
    kind: asset.kind,
    storageDriver: asset.storageDriver,
    originalName: asset.originalName,
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes,
    createdAt: asset.createdAt,
    downloadUrl: asset.downloadUrl,
    metadata: asset.metadata,
  };
}

export function toJobDto(job: ProcessingJob): ProcessingJob {
  return { ...job };
}
