import type { MediaAssetDto, ProcessingJob, StoredMediaAsset } from "../types.js";

export function toAssetDto(asset: StoredMediaAsset): MediaAssetDto {
  return {
    id: asset.id,
    kind: asset.kind,
    storageDriver: asset.storageDriver,
    originalName: asset.originalName,
    mimeType: asset.mimeType,
    thumbnailMimeType: asset.thumbnailMimeType ?? null,
    sizeBytes: asset.sizeBytes,
    createdAt: asset.createdAt,
    downloadUrl: asset.downloadUrl || `/api/v1/assets/${asset.id}/download`,
    thumbnailUrl:
      asset.thumbnailUrl ??
      (asset.thumbnailStorageKey ? `/api/v1/assets/${asset.id}/thumbnail` : null),
    metadata: asset.metadata,
  };
}

export function toJobDto(job: ProcessingJob): ProcessingJob {
  return { ...job };
}
