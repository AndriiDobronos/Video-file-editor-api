# Image Convert API Draft

This document proposes the first backend contract for converting still images between `png`, `jpeg`, and `webp` while keeping the current queue-driven architecture.

## Goal

Allow the frontend to submit an uploaded image asset, choose a target format, and receive a queued job that produces a downloadable output asset in the same way as trim, merge, and normalize already do for video.

## Route

`POST /api/v1/jobs/convert-image`

This route should stay separate from video transcoding because the editor will eventually need a broader video convert flow with different settings and validation.

## Request payload

```json
{
  "assetId": "existing-uploaded-asset-id",
  "target": {
    "format": "png",
    "quality": 92,
    "width": 1920,
    "height": 1080,
    "fit": "contain",
    "background": "#ffffff"
  }
}
```

## Request rules

- `assetId` is required and must point to an existing asset.
- The source asset must be an image upload or output with MIME type `image/png`, `image/jpeg`, or `image/webp`.
- `target.format` is required and must be one of `png`, `jpeg`, or `webp`.
- `quality` is optional and should be limited to `1..100`.
- `width` and `height` are optional positive integers.
- `fit` is optional and should be one of `contain`, `cover`, or `stretch`.
- `background` is optional and is used when the source contains transparency and the target format does not support it well, especially `jpeg`.

## Suggested Zod schema

```ts
const convertImageJobSchema = z.object({
  assetId: z.string().min(1),
  target: z.object({
    format: z.enum(["png", "jpeg", "webp"]),
    quality: z.number().int().min(1).max(100).optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    fit: z.enum(["contain", "cover", "stretch"]).optional(),
    background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  }),
});
```

## Response shape

The route should return the same queue response style that existing processing routes use:

```json
{
  "item": {
    "id": "job-id",
    "type": "convert-image",
    "status": "queued",
    "sourceAssetIds": ["existing-uploaded-asset-id"],
    "outputAssetId": null,
    "downloadUrl": null,
    "error": null,
    "createdAt": "2026-06-23T12:00:00.000Z",
    "updatedAt": "2026-06-23T12:00:00.000Z",
    "progress": 0,
    "options": {
      "assetId": "existing-uploaded-asset-id",
      "target": {
        "format": "png",
        "quality": 92,
        "width": 1920,
        "height": 1080,
        "fit": "contain",
        "background": "#ffffff"
      }
    }
  }
}
```

## Queue model changes

- Extend `JobType` with `convert-image`.
- Add `ConvertImageJobOptions` to the shared job types.
- Reuse the current BullMQ queue rather than introducing a separate image queue.
- Reuse the existing `ProcessingJob` record structure so the frontend polling logic stays unchanged.

## Output behavior

- Store the converted file as a regular output asset via `registerOutputAsset(...)`.
- Generate a filename such as:
  - `photo-converted.png`
  - `cover-converted.jpg`
  - `banner-converted.webp`
- Set the output MIME type from the selected target format:
  - `png` -> `image/png`
  - `jpeg` -> `image/jpeg`
  - `webp` -> `image/webp`

## FFmpeg conversion strategy

The implementation can stay inside the current media-processing layer and reuse the same staging flow used for R2-backed assets.

### Shared preprocessing

- Download the asset locally when `MEDIA_STORAGE_DRIVER=r2`.
- Build an optional `scale` filter when `width` or `height` is provided.
- Apply `fit` behavior:
  - `contain` -> scale inside bounds and pad if both dimensions are provided
  - `cover` -> scale and crop to fill bounds
  - `stretch` -> direct scale to exact width and height

## Target-specific commands

### PNG output

```bash
ffmpeg -y -i input.ext -frames:v 1 output.png
```

### JPEG output

```bash
ffmpeg -y -i input.ext -frames:v 1 -q:v 2 output.jpg
```

Notes:

- If the source has transparency, composite onto `background` before export.
- Default `background` should be `#ffffff` unless the frontend explicitly chooses another color.

### WEBP output

```bash
ffmpeg -y -i input.ext -frames:v 1 -c:v libwebp -quality 92 output.webp
```

Notes:

- `quality` should default to something user-friendly such as `92`.
- When the source contains transparency, keep alpha for `png` and `webp`.

## Validation and error messages

- If the source asset is not an image:
  - `Asset "<id>" is not a supported image source.`
- If the target format equals the current format and no resize options were provided:
  - `Convert job would not change the file. Choose another format or resize target.`
- If only one of `width` or `height` is provided:
  - accept it and preserve aspect ratio unless `fit=stretch`.

## Frontend integration notes

- Add a new action card named `Convert image`.
- Show it only when the selected asset is an image.
- Reuse the existing job history list and polling behavior.
- Reuse `thumbnailUrl` in the asset list so converted images remain visually identifiable.

## Recommended implementation order

1. Add shared types and Zod schema.
2. Add `createConvertImageJob(...)` in the jobs module.
3. Add `processConvertImageJob(...)` in the media layer.
4. Wire a new BullMQ worker branch for `convert-image`.
5. Expose `POST /api/v1/jobs/convert-image`.
6. Add frontend controls after the backend contract is stable.
