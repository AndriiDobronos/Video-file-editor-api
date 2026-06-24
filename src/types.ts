export type MediaAssetKind = "upload" | "output";
export type MediaStorageDriver = "local" | "r2";

export type JobType =
  | "trim"
  | "merge"
  | "normalize"
  | "compress-video"
  | "extract-frame"
  | "overlay-text"
  | "crop-pad"
  | "convert-image";

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

export type VideoCompressionMode = "simple" | "advanced";
export type VideoCompressionPreset = "high-quality" | "balanced" | "small-file";
export type VideoCompressionEncoderPreset =
  | "ultrafast"
  | "superfast"
  | "veryfast"
  | "faster"
  | "fast"
  | "medium"
  | "slow";

export type VideoCompressionTarget = {
  mode: VideoCompressionMode;
  preset?: VideoCompressionPreset;
  crf?: number;
  videoBitrateKbps?: number;
  audioBitrateKbps?: number;
  encoderPreset?: VideoCompressionEncoderPreset;
};

export type CompressVideoJobOptions = {
  assetId: string;
  target: VideoCompressionTarget;
};

export type ConvertImageFormat = "png" | "jpeg" | "webp";
export type ConvertImageFit = "contain" | "cover" | "stretch";
export type CropPadMode = "crop" | "pad";
export type CropPadAnchorX = "left" | "center" | "right";
export type CropPadAnchorY = "top" | "center" | "bottom";
export type TextOverlayHorizontal = "left" | "center" | "right";
export type TextOverlayVertical = "top" | "center" | "bottom";

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

export type ExtractFrameTarget = {
  timeSeconds: number;
  format: ConvertImageFormat;
  quality?: number;
  width?: number;
  height?: number;
  fit?: ConvertImageFit;
  background?: string;
};

export type ExtractFrameJobOptions = {
  assetId: string;
  target: ExtractFrameTarget;
};

export type TextOverlayTarget = {
  text: string;
  startTime?: number;
  endTime?: number;
  fontSize?: number;
  fontColor?: string;
  backgroundColor?: string;
  horizontal?: TextOverlayHorizontal;
  vertical?: TextOverlayVertical;
};

export type OverlayTextJobOptions = {
  assetId: string;
  target: TextOverlayTarget;
};

export type CropPadTarget = {
  mode: CropPadMode;
  width: number;
  height: number;
  anchorX?: CropPadAnchorX;
  anchorY?: CropPadAnchorY;
  background?: string;
};

export type CropPadJobOptions = {
  assetId: string;
  target: CropPadTarget;
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
    | CompressVideoJobOptions
    | ExtractFrameJobOptions
    | OverlayTextJobOptions
    | CropPadJobOptions
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
    | CompressVideoJobOptions
    | ExtractFrameJobOptions
    | OverlayTextJobOptions
    | CropPadJobOptions
    | ConvertImageJobOptions;
};

export type QueueJobResult = {
  outputAssetId: string;
  downloadUrl: string;
};
