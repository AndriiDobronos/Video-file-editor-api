export type MediaAssetKind = "upload" | "output";
export type MediaStorageDriver = "local" | "r2";

export type JobType =
  | "trim"
  | "merge"
  | "transition-merge"
  | "normalize"
  | "compress-video"
  | "export-animation"
  | "extract-frame"
  | "extract-audio"
  | "edit-audio-track"
  | "change-speed"
  | "audio-volume"
  | "overlay-text"
  | "subtitle-burn-in"
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

export type MediaInspectionStream = {
  index: number;
  codecType: string | null;
  codecName: string | null;
  codecLongName: string | null;
  width: number | null;
  height: number | null;
  pixelFormat: string | null;
  frameRate: string | null;
  averageFrameRate: string | null;
  sampleAspectRatio: string | null;
  displayAspectRatio: string | null;
  bitRate: number | null;
  durationSeconds: number | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  audioChannelLayout: string | null;
  rotationDegrees: number | null;
};

export type MediaInspection = {
  formatName: string | null;
  formatLongName: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  bitRate: number | null;
  probeScore: number | null;
  streamCount: number;
  videoStreamCount: number;
  audioStreamCount: number;
  inspectedAt: string;
  streams: MediaInspectionStream[];
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
  metadataInspection: MediaInspection | null;
};

export type MediaAssetDto = Omit<
  StoredMediaAsset,
  | "filePath"
  | "storedName"
  | "storageKey"
  | "thumbnailFilePath"
  | "thumbnailStorageKey"
  | "metadataInspection"
>;

export type TrimJobOptions = {
  assetId: string;
  startTime: number;
  endTime: number;
};

export type MergeJobOptions = {
  sourceAssetIds: string[];
};

export type TransitionMergeType = "crossfade" | "fade-black";
export type TransitionMergeAudioMode = "crossfade" | "hard-cut";

export type TransitionMergeTarget = {
  transition: TransitionMergeType;
  overlapSeconds: number;
  audioMode: TransitionMergeAudioMode;
};

export type TransitionMergeJobOptions = {
  sourceAssetIds: [string, string];
  target: TransitionMergeTarget;
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

export type AnimationExportFormat = "gif" | "webp";

export type AnimationExportTarget = {
  format: AnimationExportFormat;
  startTime: number;
  durationSeconds: number;
  width?: number;
  fps?: number;
  quality?: number;
};

export type AnimationExportJobOptions = {
  assetId: string;
  target: AnimationExportTarget;
};

export type ConvertImageFormat = "png" | "jpeg" | "webp";
export type ConvertImageFit = "contain" | "cover" | "stretch";
export type CropPadMode = "crop" | "pad";
export type CropPadAnchorX = "left" | "center" | "right";
export type CropPadAnchorY = "top" | "center" | "bottom";
export type TextOverlayHorizontal = "left" | "center" | "right";
export type TextOverlayVertical = "top" | "center" | "bottom";
export type AudioExtractFormat = "mp3" | "m4a" | "wav";
export type AudioTrackEditMode = "mute" | "replace";

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

export type AudioExtractTarget = {
  format: AudioExtractFormat;
};

export type ExtractAudioJobOptions = {
  assetId: string;
  target: AudioExtractTarget;
};

export type AudioTrackEditTarget = {
  mode: AudioTrackEditMode;
  replacementAssetId?: string;
  loopReplacement?: boolean;
};

export type EditAudioTrackJobOptions = {
  assetId: string;
  target: AudioTrackEditTarget;
};

export type PlaybackSpeedTarget = {
  rate: number;
};

export type ChangeSpeedJobOptions = {
  assetId: string;
  target: PlaybackSpeedTarget;
};

export type AudioVolumeTarget = {
  gainDb?: number;
  mute?: boolean;
  startTime?: number;
  endTime?: number;
  preventClipping?: boolean;
};

export type AudioVolumeJobOptions = {
  assetId: string;
  target: AudioVolumeTarget;
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

export type SubtitleBurnInAlignment =
  | "bottom-center"
  | "bottom-left"
  | "bottom-right"
  | "top-center";

export type SubtitleBurnInTarget = {
  subtitleFileName: string;
  subtitleContent: string;
  fontSize?: number;
  fontColor?: string;
  outlineColor?: string;
  alignment?: SubtitleBurnInAlignment;
  marginVertical?: number;
};

export type SubtitleBurnInJobOptions = {
  assetId: string;
  target: SubtitleBurnInTarget;
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
    | TransitionMergeJobOptions
    | NormalizeJobOptions
    | CompressVideoJobOptions
    | AnimationExportJobOptions
    | ExtractFrameJobOptions
    | ExtractAudioJobOptions
    | EditAudioTrackJobOptions
    | ChangeSpeedJobOptions
    | AudioVolumeJobOptions
    | OverlayTextJobOptions
    | SubtitleBurnInJobOptions
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
    | TransitionMergeJobOptions
    | NormalizeJobOptions
    | CompressVideoJobOptions
    | AnimationExportJobOptions
    | ExtractFrameJobOptions
    | ExtractAudioJobOptions
    | EditAudioTrackJobOptions
    | ChangeSpeedJobOptions
    | AudioVolumeJobOptions
    | OverlayTextJobOptions
    | SubtitleBurnInJobOptions
    | CropPadJobOptions
    | ConvertImageJobOptions;
};

export type QueueJobResult = {
  outputAssetId: string;
  downloadUrl: string;
};
