export type MediaAssetKind = "upload" | "output";
export type MediaStorageDriver = "local" | "r2";

export type JobType = "trim" | "merge" | "normalize" | "convert-image";

export type JobStatus = "queued" | "processing" | "completed" | "failed";

export type MediaMetadata = {
  formatName: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  bitRate: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  frameRate: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
};

export type StoredMediaAsset = {
  id: string;
  kind: MediaAssetKind;
  storageDriver: MediaStorageDriver;
  storageKey: string;
  thumbnailStorageKey: string | null;
  originalName: string;
  storedName: string;
  mimeType: string;
  thumbnailMimeType: string | null;
  sizeBytes: number;
  filePath: string | null;
  thumbnailFilePath: string | null;
  createdAt: string;
  downloadUrl: string;
  thumbnailUrl: string | null;
  metadata: MediaMetadata | null;
};

export type MediaAssetDto = Omit<
  StoredMediaAsset,
  | "filePath"
  | "storedName"
  | "storageKey"
  | "thumbnailFilePath"
  | "thumbnailStorageKey"
>;

export type TrimJobOptions = {
  assetId: string;
  startTime: number;
  endTime: number;
};

export type MergeJobOptions = {
  sourceAssetIds: string[];
};

export type NormalizeTargetPreset =
  | "hd-720p"
  | "match-largest"
  | "match-smallest"
  | "match-average";

export type NormalizeTargetProfile = {
  preset: NormalizeTargetPreset;
  width: number;
  height: number;
  frameRate: number;
  audioSampleRate: number;
  audioChannels: number;
  videoCodec: "h264";
  audioCodec: "aac";
};

export type NormalizeJobOptions = {
  assetId: string;
  target: NormalizeTargetProfile;
};

export type ConvertImageFormat = "png" | "jpeg" | "webp";
export type ConvertImageFit = "contain" | "cover" | "stretch";

export type ConvertImageTarget = {
  format: ConvertImageFormat;
  quality?: number;
  width?: number;
  height?: number;
  fit?: ConvertImageFit;
  background?: string;
};

export type ConvertImageJobOptions = {
  assetId: string;
  target: ConvertImageTarget;
};

export type JobProgress = string | boolean | number | object | null;

export type ProcessingJob = {
  id: string;
  type: JobType;
  status: JobStatus;
  sourceAssetIds: string[];
  outputAssetId: string | null;
  downloadUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  progress: JobProgress;
  options:
    | TrimJobOptions
    | MergeJobOptions
    | NormalizeJobOptions
    | ConvertImageJobOptions;
};

export type QueueJobData = {
  jobId: string;
  type: JobType;
  sourceAssetIds: string[];
  options:
    | TrimJobOptions
    | MergeJobOptions
    | NormalizeJobOptions
    | ConvertImageJobOptions;
};

export type QueueJobResult = {
  outputAssetId: string;
  downloadUrl: string;
};
