import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const MiniFilmProfileLeafSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    relative: z.string(),
  })
  .meta({ id: 'MiniFilmProfileLeafDto' });

type MiniFilmProfileNode = {
  label: string;
  profiles: z.infer<typeof MiniFilmProfileLeafSchema>[];
  children: MiniFilmProfileNode[];
};

const MiniFilmProfileNodeSchema: z.ZodType<MiniFilmProfileNode> = z.lazy(() =>
  z
    .object({
      label: z.string(),
      profiles: z.array(MiniFilmProfileLeafSchema),
      children: z.array(MiniFilmProfileNodeSchema),
    })
    .meta({ id: 'MiniFilmProfileNodeDto' }),
);

const MiniFilmProfileTreeSchema = z
  .object({
    root: z.string(),
    count: z.int().min(0),
    children: z.array(MiniFilmProfileNodeSchema),
  })
  .meta({ id: 'MiniFilmProfileTreeDto' });

const MiniFilmOutputFormatSchema = z.enum(['jpg', 'tiff']);
const MiniFilmJpegSubsamplingSchema = z.enum(['s444', 's422', 's420']);
const MiniFilmGallerySchema = z.enum(['modern', 'soft', 'compact', 'hero', 'phone', 'all', '']);
const MiniFilmGrainPresetSchema = z.enum(['', 'light', 'medium', 'heavy']);

const MiniFilmCommonOptionsSchema = z.object({
  profiles: z.array(z.string()).optional(),
  jobs: z.int().min(1).max(64).optional(),
  outputFormat: MiniFilmOutputFormatSchema.optional(),
  jpgQuality: z.int().min(1).max(100).optional(),
  jpegSubsampling: MiniFilmJpegSubsamplingSchema.optional(),
  progressive: z.boolean().optional(),
  stripMetadata: z.boolean().optional(),
  longEdge: z.int().min(0).optional(),
  gallery: MiniFilmGallerySchema.optional(),
  galleryThumbnailLongEdge: z.int().min(1).optional(),
  galleryColumns: z.int().min(1).max(20).optional(),
  publishAlbum: z.string().optional(),
  noGrain: z.boolean().optional(),
  colorNoiseIsoThreshold: z.int().min(0).optional(),
  lensCorrections: z.string().optional(),
  grainPreset: MiniFilmGrainPresetSchema.optional(),
  grain: z.string().optional(),
  albumName: z.string().optional(),
});

const MiniFilmReviewSessionCreateSchema = MiniFilmCommonOptionsSchema.extend({
  name: z.string().optional(),
  albumId: z.uuidv4().optional(),
  assetIds: z.array(z.uuidv4()).optional(),
})
  .refine((dto) => Boolean(dto.albumId) !== Boolean(dto.assetIds?.length), {
    error: 'Provide either albumId or assetIds',
    path: ['assetIds'],
  })
  .meta({ id: 'MiniFilmReviewSessionCreateDto' });

const MiniFilmApplyJobCreateSchema = MiniFilmCommonOptionsSchema.extend({
  assetIds: z.array(z.uuidv4()).min(1),
}).meta({ id: 'MiniFilmApplyJobCreateDto' });

const MiniFilmReviewSessionImportSchema = z
  .object({
    albumName: z.string().optional(),
    publishAlbum: z.string().optional(),
    minRating: z.int().min(0).max(5).optional(),
    labels: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    rerenderRaw: z.boolean().optional(),
  })
  .meta({ id: 'MiniFilmReviewSessionImportDto' });

const MiniFilmSkippedAssetSchema = z
  .object({
    id: z.string(),
    originalFileName: z.string(),
    reason: z.string(),
  })
  .meta({ id: 'MiniFilmSkippedAssetDto' });

const MiniFilmReviewSessionStatusSchema = z.enum(['starting', 'running', 'stopped', 'failed', 'importing', 'imported']);
const MiniFilmApplyJobStatusSchema = z.enum(['queued', 'running', 'completed', 'failed']);
const MiniFilmProgressStageSchema = z.enum([
  'starting',
  'discovering',
  'rendering',
  'importing',
  'completed',
  'failed',
]);

const MiniFilmProgressSchema = z
  .object({
    stage: MiniFilmProgressStageSchema,
    processed: z.int().min(0),
    total: z.int().min(0),
    percent: z.number().min(0).max(1),
    currentFile: z.string().optional(),
    currentProfile: z.string().optional(),
    message: z.string().optional(),
    updatedAt: z.string(),
    imported: z.int().min(0).optional(),
    skipped: z.int().min(0).optional(),
  })
  .meta({ id: 'MiniFilmProgressDto' });

const MiniFilmProgressEventSchema = z
  .object({
    mode: z.enum(['apply', 'review']),
    id: z.string(),
    status: z.string(),
    progress: MiniFilmProgressSchema,
    albumId: z.string().optional(),
    importedAssetIds: z.array(z.string()).optional(),
  })
  .meta({ id: 'MiniFilmProgressEventDto' });

const MiniFilmReviewSessionResponseSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    name: z.string(),
    status: MiniFilmReviewSessionStatusSchema,
    reviewUrl: z.string(),
    reviewPort: z.int().min(1).max(65_535),
    inputDir: z.string(),
    outputDir: z.string(),
    statePath: z.string(),
    historyPath: z.string(),
    publishAlbum: z.string(),
    assetIds: z.array(z.string()),
    skippedAssets: z.array(MiniFilmSkippedAssetSchema),
    profiles: z.array(z.string()),
    createdAt: z.string(),
    updatedAt: z.string(),
    exitCode: z.number().nullable().optional(),
    signal: z.string().nullable().optional(),
    logs: z.string().optional(),
    importedAlbumId: z.string().optional(),
    importedAssetIds: z.array(z.string()).optional(),
    progress: MiniFilmProgressSchema,
  })
  .meta({ id: 'MiniFilmReviewSessionResponseDto' });

const MiniFilmApplyJobResponseSchema = z
  .object({
    id: z.string(),
    userId: z.string(),
    status: MiniFilmApplyJobStatusSchema,
    inputDir: z.string().optional(),
    outputDir: z.string(),
    assetIds: z.array(z.string()),
    rawAssetIds: z.array(z.string()),
    skippedAssets: z.array(MiniFilmSkippedAssetSchema),
    profiles: z.array(z.string()),
    createdAt: z.string(),
    updatedAt: z.string(),
    processed: z.int().min(0),
    total: z.int().min(0),
    logs: z.string().optional(),
    error: z.string().optional(),
    albumId: z.string().optional(),
    importedAssetIds: z.array(z.string()).optional(),
    progress: MiniFilmProgressSchema,
  })
  .meta({ id: 'MiniFilmApplyJobResponseDto' });

const MiniFilmImportResponseSchema = z
  .object({
    albumId: z.string(),
    assetIds: z.array(z.string()),
    imported: z.int().min(0),
    session: MiniFilmReviewSessionResponseSchema,
  })
  .meta({ id: 'MiniFilmImportResponseDto' });

export class MiniFilmProfileTreeDto extends createZodDto(MiniFilmProfileTreeSchema) {}
export class MiniFilmReviewSessionCreateDto extends createZodDto(MiniFilmReviewSessionCreateSchema) {}
export class MiniFilmApplyJobCreateDto extends createZodDto(MiniFilmApplyJobCreateSchema) {}
export class MiniFilmReviewSessionImportDto extends createZodDto(MiniFilmReviewSessionImportSchema) {}
export class MiniFilmReviewSessionResponseDto extends createZodDto(MiniFilmReviewSessionResponseSchema) {}
export class MiniFilmApplyJobResponseDto extends createZodDto(MiniFilmApplyJobResponseSchema) {}
export class MiniFilmImportResponseDto extends createZodDto(MiniFilmImportResponseSchema) {}
export class MiniFilmProgressDto extends createZodDto(MiniFilmProgressSchema) {}
export class MiniFilmProgressEventDto extends createZodDto(MiniFilmProgressEventSchema) {}

export type MiniFilmProfileLeafDto = z.infer<typeof MiniFilmProfileLeafSchema>;
export type MiniFilmProfileNodeDto = MiniFilmProfileNode;
export type MiniFilmProgress = z.infer<typeof MiniFilmProgressSchema>;
export type MiniFilmProgressEvent = z.infer<typeof MiniFilmProgressEventSchema>;
