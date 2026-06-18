import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import chokidar, { type FSWatcher } from 'chokidar';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import sanitize from 'sanitize-filename';
import { SystemConfig } from 'src/config';
import { Asset } from 'src/database';
import { mapAsset } from 'src/dtos/asset-response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  MiniFilmApplyJobCreateDto,
  MiniFilmApplyJobResponseDto,
  MiniFilmImportResponseDto,
  MiniFilmProfileLeafDto,
  MiniFilmProfileNodeDto,
  MiniFilmProfileTreeDto,
  MiniFilmProgress,
  MiniFilmReviewSessionCreateDto,
  MiniFilmReviewSessionImportDto,
  MiniFilmReviewSessionResponseDto,
} from 'src/dtos/mini-film.dto';
import { AlbumUserRole, AssetType, JobName, Permission, SystemMetadataKey } from 'src/enum';
import { AlbumService } from 'src/services/album.service';
import { AssetMediaService } from 'src/services/asset-media.service';
import { BaseService } from 'src/services/base.service';
import { mimeTypes } from 'src/utils/mime-types';

type MiniFilmConfig = SystemConfig['miniFilm'];
type MiniFilmStatus = 'starting' | 'running' | 'stopped' | 'failed' | 'importing' | 'imported';
type MiniFilmApplyStatus = 'queued' | 'running' | 'completed' | 'failed';

type MiniFilmSkippedAsset = {
  id: string;
  originalFileName: string;
  reason: string;
};

type MiniFilmMode = 'apply' | 'review';
type MiniFilmHistoryStatus = 'missing' | 'queued' | 'processing' | 'done' | 'failed' | 'running' | 'skipped';
type MiniFilmPublishStatus = 'running' | 'done' | 'failed';

type MiniFilmHistoryWorkItem = {
  key: string;
  file?: string;
  profile?: string;
  status: MiniFilmHistoryStatus;
};

type MiniFilmPublishHistoryWorkItem = {
  id: string;
  album?: string;
  status: MiniFilmPublishStatus;
  processed: number;
  total: number;
  linked: number;
  current?: string;
};

type MiniFilmHistoryWatcher = {
  watcher: FSWatcher;
  offset: number;
  buffer: string;
  workItems: Map<string, MiniFilmHistoryWorkItem>;
  publishJobs: Map<string, MiniFilmPublishHistoryWorkItem>;
  imageIds: Set<string>;
  currentFile?: string;
  currentProfile?: string;
  message?: string;
  publishCompleted: boolean;
  publishFailed: boolean;
};

type MiniFilmLiveImportWatcher = {
  watcher: FSWatcher;
  auth: AuthDto;
  publishDir: string;
  albumId: string;
  importedFiles: Set<string>;
  importingFiles: Set<string>;
  seenFiles: Map<string, { size: number; mtimeMs: number }>;
  completedPublishJobs: Set<string>;
  scanPromise?: Promise<void>;
  completionPromise?: Promise<void>;
  publishFailed: boolean;
  stopped: boolean;
};

type StoredReviewSession = {
  id: string;
  userId: string;
  name: string;
  status: MiniFilmStatus;
  reviewUrl: string;
  reviewPort: number;
  inputDir: string;
  outputDir: string;
  statePath: string;
  historyPath: string;
  publishAlbum: string;
  assetIds: string[];
  skippedAssets: MiniFilmSkippedAsset[];
  profiles: string[];
  createdAt: string;
  updatedAt: string;
  command: string[];
  logs: string;
  exitCode?: number | null;
  signal?: string | null;
  importedAlbumId?: string;
  importedAssetIds?: string[];
  progress: MiniFilmProgress;
};

type StoredApplyJob = {
  id: string;
  userId: string;
  status: MiniFilmApplyStatus;
  outputDir: string;
  assetIds: string[];
  rawAssetIds: string[];
  skippedAssets: MiniFilmSkippedAsset[];
  profiles: string[];
  createdAt: string;
  updatedAt: string;
  processed: number;
  total: number;
  logs: string;
  error?: string;
  albumName: string;
  albumId?: string;
  importedAssetIds?: string[];
  progress: MiniFilmProgress;
};

type MiniFilmState = {
  reviewSessions: Record<string, StoredReviewSession>;
  applyJobs: Record<string, StoredApplyJob>;
};

type MiniFilmCommonOptions = Partial<MiniFilmConfig> & {
  profiles?: string[];
  jobs?: number;
  albumName?: string;
};

type ProfileNodeMutable = {
  profiles: MiniFilmProfileLeafDto[];
  children: Map<string, ProfileNodeMutable>;
};

const MAX_LOG_LENGTH = 64 * 1024;
const IMPORT_SCAN_INTERVAL_MS = 1000;
const IMPORT_STABLE_DELAY_MS = 750;
const MINI_FILM_JOB_PRIORITY = 1;

@Injectable()
export class MiniFilmService extends BaseService {
  private reviewProcesses = new Map<string, ChildProcess>();
  private reviewImportProcesses = new Map<string, ChildProcess>();
  private reviewHistoryWatchers = new Map<string, MiniFilmHistoryWatcher>();
  private reviewLiveImportWatchers = new Map<string, MiniFilmLiveImportWatcher>();

  async getProfileTree(auth: AuthDto, includeAll = false): Promise<MiniFilmProfileTreeDto> {
    if (includeAll && !auth.user.isAdmin) {
      throw new ForbiddenException();
    }
    const systemConfig = await this.getConfig({ withCache: false });
    const config = systemConfig.miniFilm;
    return this.buildProfileTree(config, includeAll);
  }

  async createReviewSession(
    auth: AuthDto,
    dto: MiniFilmReviewSessionCreateDto,
  ): Promise<MiniFilmReviewSessionResponseDto> {
    const config = await this.requireEnabled();
    const profiles = await this.resolveProfiles(config, dto.profiles);
    const { assets, skippedAssets, name } = await this.resolveReviewAssets(auth, dto);
    if (assets.length === 0) {
      throw new BadRequestException('No supported image assets selected for mini-film review');
    }

    await this.stopActiveReviewSessionsForUser(auth.user.id);

    const id = this.cryptoRepository.randomUUID();
    const createdAt = new Date().toISOString();
    const root = path.join(path.resolve(config.workRoot), auth.user.id, id);
    const inputDir = path.join(root, 'input');
    const outputDir = path.join(root, 'output');
    const statePath = path.join(outputDir, 'mini-film-review.json');
    const historyPath = path.join(outputDir, 'history.txt');
    const publishAlbum = this.publishAlbumName(dto.publishAlbum ?? config.publishAlbum);
    const publishDir = this.resolveInside(outputDir, publishAlbum);
    const reviewPort = await this.allocatePort(config.reviewPortStart, config.reviewPortEnd);
    const reviewUrl = `/api/mini-film/review-sessions/${id}/review/`;
    const sessionName = dto.name || dto.albumName || name || `mini-film review ${createdAt}`;

    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(publishDir, { recursive: true });
    await this.ensureMiniFilmRuntimeDirs(config);
    await this.symlinkInputs(inputDir, assets);
    const album = await BaseService.create(AlbumService, this).create(auth, {
      albumName: sessionName,
      assetIds: [],
      albumUsers: [{ userId: auth.user.id, role: AlbumUserRole.Owner }],
    });

    const args = [
      'daemon',
      inputDir,
      outputDir,
      ...this.profileArgs(profiles),
      ...this.daemonArgs(config, dto),
      '--publish-album',
      publishAlbum,
      '--review-address',
      `127.0.0.1:${reviewPort}`,
    ];
    const session: StoredReviewSession = {
      id,
      userId: auth.user.id,
      name: sessionName,
      status: 'running',
      reviewUrl,
      reviewPort,
      inputDir,
      outputDir,
      statePath,
      historyPath,
      publishAlbum,
      assetIds: assets.map((asset) => asset.id),
      skippedAssets,
      profiles,
      createdAt,
      updatedAt: createdAt,
      command: [config.binaryPath, ...args],
      logs: '',
      importedAlbumId: album.id,
      importedAssetIds: [],
      progress: {
        stage: 'starting',
        processed: 0,
        total: 0,
        percent: 0,
        message: 'Waiting for mini-film history',
        updatedAt: createdAt,
        skipped: skippedAssets.length,
      },
    };

    await this.updateState((state) => {
      state.reviewSessions[id] = session;
    });

    const child = spawn(config.binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: this.miniFilmEnv(config) });
    this.reviewProcesses.set(id, child);
    this.startReviewHistoryWatcher(id, outputDir, historyPath);
    this.startReviewLiveImportWatcher(auth, id, publishDir, album.id);
    child.stdout.on('data', (chunk) => void this.appendReviewLog(id, chunk.toString()));
    child.stderr.on('data', (chunk) => void this.appendReviewLog(id, chunk.toString()));
    child.on('error', (error) => void this.markReviewFailed(id, error));
    child.on('exit', (code, signal) => void this.markReviewExited(id, code, signal));

    return this.getReviewSession(auth, id);
  }

  async listReviewSessions(auth: AuthDto): Promise<MiniFilmReviewSessionResponseDto[]> {
    const state = await this.getState();
    return Object.values(state.reviewSessions)
      .filter((session) => this.canSee(auth, session.userId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getReviewSession(auth: AuthDto, id: string): Promise<MiniFilmReviewSessionResponseDto> {
    const session = await this.findReviewSession(id);
    this.assertCanSee(auth, session.userId);
    return session;
  }

  async stopReviewSession(auth: AuthDto, id: string): Promise<void> {
    const session = await this.findReviewSession(id);
    this.assertCanSee(auth, session.userId);
    this.stopReviewImportProcess(id);
    this.stopReviewProcess(id);
    void this.stopReviewHistoryWatcher(id);
    void this.stopReviewLiveImportWatcher(id);
    await this.patchReviewSession(
      id,
      (current) => ({
        ...current,
        status: current.status === 'imported' ? current.status : 'stopped',
        progress:
          current.status === 'imported'
            ? current.progress
            : this.withProgressStatus(current.progress, 'completed', 'mini-film review stopped'),
        updatedAt: new Date().toISOString(),
      }),
      { emitProgress: true },
    );
  }

  async deleteReviewSession(auth: AuthDto, id: string): Promise<void> {
    const session = await this.findReviewSession(id);
    this.assertCanSee(auth, session.userId);
    this.stopReviewImportProcess(id);
    this.stopReviewProcess(id);
    void this.stopReviewHistoryWatcher(id);
    void this.stopReviewLiveImportWatcher(id);
    await this.updateState((state) => {
      delete state.reviewSessions[id];
    });
  }

  async importReviewSession(
    auth: AuthDto,
    id: string,
    dto: MiniFilmReviewSessionImportDto,
  ): Promise<MiniFilmImportResponseDto> {
    const config = await this.requireEnabled();
    const session = await this.findReviewSession(id);
    this.assertCanSee(auth, session.userId);

    if (session.status === 'importing' && session.importedAlbumId) {
      return {
        albumId: session.importedAlbumId,
        assetIds: session.importedAssetIds ?? [],
        imported: session.importedAssetIds?.length ?? 0,
        session,
      };
    }

    if (session.status === 'imported' && session.importedAlbumId) {
      return {
        albumId: session.importedAlbumId,
        assetIds: session.importedAssetIds ?? [],
        imported: session.importedAssetIds?.length ?? 0,
        session,
      };
    }

    if (session.status === 'running' && session.importedAlbumId && this.reviewLiveImportWatchers.has(id)) {
      return {
        albumId: session.importedAlbumId,
        assetIds: session.importedAssetIds ?? [],
        imported: session.importedAssetIds?.length ?? 0,
        session,
      };
    }

    if (session.status !== 'running') {
      throw new BadRequestException(this.reviewUnavailableMessage(session));
    }

    if (!(await this.fileExists(session.statePath))) {
      throw new BadRequestException(`mini-film review state is not ready at ${session.statePath}`);
    }

    const publishAlbum = this.publishAlbumName(dto.publishAlbum ?? session.publishAlbum ?? config.publishAlbum);
    const publishDir = this.resolveInside(session.outputDir, publishAlbum);
    const albumName = dto.albumName || session.name;
    await fs.mkdir(publishDir, { recursive: true });
    await this.ensureMiniFilmRuntimeDirs(config);
    const album = await BaseService.create(AlbumService, this).create(auth, {
      albumName,
      assetIds: [],
      albumUsers: [{ userId: auth.user.id, role: AlbumUserRole.Owner }],
    });

    await this.patchReviewSession(
      id,
      (current) => ({
        ...current,
        status: 'importing',
        publishAlbum,
        importedAlbumId: album.id,
        importedAssetIds: current.importedAssetIds ?? [],
        progress: this.withProgressStatus(current.progress, 'importing', 'Importing mini-film outputs into Immich', {
          imported: current.importedAssetIds?.length ?? 0,
        }),
        updatedAt: new Date().toISOString(),
      }),
      { emitProgress: true },
    );

    void this.runReviewImportJob(auth, id, config, dto, publishAlbum, publishDir, album.id);

    const updated = await this.getReviewSession(auth, id);
    return {
      albumId: album.id,
      assetIds: updated.importedAssetIds ?? [],
      imported: updated.importedAssetIds?.length ?? 0,
      session: updated,
    };
  }

  async getReviewProxyTarget(auth: AuthDto, id: string): Promise<{ port: number }> {
    const session = await this.findReviewSession(id);
    this.assertCanSee(auth, session.userId);
    if (session.status !== 'running') {
      throw new BadRequestException(this.reviewUnavailableMessage(session));
    }
    if (!this.reviewProcesses.has(id)) {
      await this.patchReviewSession(id, (current) => ({
        ...current,
        status: 'failed',
        logs: this.limitLog(`${current.logs}\nmini-film review daemon is not running in this Immich server process\n`),
        updatedAt: new Date().toISOString(),
      }));
      throw new BadRequestException('mini-film review daemon is not running; start a new review session');
    }
    return { port: session.reviewPort };
  }

  async createApplyJob(auth: AuthDto, dto: MiniFilmApplyJobCreateDto): Promise<MiniFilmApplyJobResponseDto> {
    const config = await this.requireEnabled();
    await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: dto.assetIds });
    const allAssets = await this.getAssetsInInputOrder(dto.assetIds);
    const rawAssets = allAssets.filter((asset) => mimeTypes.isRaw(asset.originalPath || asset.originalFileName));
    const skippedAssets = allAssets
      .filter((asset) => !mimeTypes.isRaw(asset.originalPath || asset.originalFileName))
      .map((asset) => ({
        id: asset.id,
        originalFileName: asset.originalFileName,
        reason: this.applySkipReason(asset),
      }));

    if (rawAssets.length === 0) {
      throw new BadRequestException('mini-film apply only runs on RAW assets; JPEG/HEIC and movies are skipped');
    }

    const profiles = await this.resolveProfiles(config, dto.profiles);
    const id = this.cryptoRepository.randomUUID();
    const createdAt = new Date().toISOString();
    const outputDir = path.join(path.resolve(config.workRoot), auth.user.id, id, 'apply-output');
    const albumName = dto.albumName || `mini-film apply ${createdAt}`;
    await fs.mkdir(outputDir, { recursive: true });
    await this.ensureMiniFilmRuntimeDirs(config);
    const album = await BaseService.create(AlbumService, this).create(auth, {
      albumName,
      assetIds: [],
      albumUsers: [{ userId: auth.user.id, role: AlbumUserRole.Owner }],
    });

    const total = rawAssets.length * Math.max(profiles.length, 1);
    const job: StoredApplyJob = {
      id,
      userId: auth.user.id,
      status: 'queued',
      outputDir,
      assetIds: allAssets.map((asset) => asset.id),
      rawAssetIds: rawAssets.map((asset) => asset.id),
      skippedAssets,
      profiles,
      createdAt,
      updatedAt: createdAt,
      processed: 0,
      total,
      logs: '',
      albumName,
      albumId: album.id,
      importedAssetIds: [],
      progress: {
        stage: 'starting',
        processed: 0,
        total,
        percent: 0,
        message: 'Queued mini-film apply job',
        updatedAt: createdAt,
        imported: 0,
        skipped: skippedAssets.length,
      },
    };

    await this.updateState((state) => {
      state.applyJobs[id] = job;
    });
    void this.runApplyJob(auth, id, config, dto, rawAssets, profiles);

    return this.getApplyJob(auth, id);
  }

  async listApplyJobs(auth: AuthDto): Promise<MiniFilmApplyJobResponseDto[]> {
    const state = await this.getState();
    return Object.values(state.applyJobs)
      .filter((job) => this.canSee(auth, job.userId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getApplyJob(auth: AuthDto, id: string): Promise<MiniFilmApplyJobResponseDto> {
    const job = await this.findApplyJob(id);
    this.assertCanSee(auth, job.userId);
    return job;
  }

  private async requireEnabled(): Promise<MiniFilmConfig> {
    const systemConfig = await this.getConfig({ withCache: false });
    const config = systemConfig.miniFilm;
    if (!config.enabled) {
      throw new BadRequestException('mini-film is disabled');
    }
    if (!config.binaryPath.trim()) {
      throw new BadRequestException('mini-film binary path is not configured');
    }
    if (!config.workRoot.trim()) {
      throw new BadRequestException('mini-film work root is not configured');
    }
    return config;
  }

  private async resolveReviewAssets(
    auth: AuthDto,
    dto: MiniFilmReviewSessionCreateDto,
  ): Promise<{ assets: Asset[]; skippedAssets: MiniFilmSkippedAsset[]; name?: string }> {
    let assets: Asset[];
    let name: string | undefined;
    if (dto.albumId) {
      await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [dto.albumId] });
      const album = await this.albumRepository.getById(dto.albumId, { withAssets: true }, auth.user.id);
      if (!album) {
        throw new NotFoundException('Album not found');
      }
      assets = (album.assets || []) as unknown as Asset[];
      name = album.albumName;
      if (assets.length > 0) {
        await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: assets.map((asset) => asset.id) });
      }
    } else {
      const assetIds = dto.assetIds || [];
      await this.requireAccess({ auth, permission: Permission.AssetDownload, ids: assetIds });
      assets = await this.getAssetsInInputOrder(assetIds);
    }

    const supported = assets.filter((asset) => mimeTypes.isImage(asset.originalPath || asset.originalFileName));
    const skippedAssets = assets
      .filter((asset) => !mimeTypes.isImage(asset.originalPath || asset.originalFileName))
      .map((asset) => ({
        id: asset.id,
        originalFileName: asset.originalFileName,
        reason: mimeTypes.isVideo(asset.originalPath || asset.originalFileName) ? 'video skipped' : 'unsupported asset',
      }));
    return { assets: supported, skippedAssets, name };
  }

  private async getAssetsInInputOrder(assetIds: string[]): Promise<Asset[]> {
    const assets = await this.assetRepository.getByIds(assetIds);
    const assetById = new Map(assets.map((asset) => [asset.id, asset as Asset]));
    return assetIds.map((id) => assetById.get(id)).filter((asset): asset is Asset => asset !== undefined);
  }

  private async symlinkInputs(inputDir: string, assets: Asset[]) {
    for (const asset of assets) {
      const originalPath = path.resolve(asset.originalPath);
      const relative = originalPath.replace(/^[/\\]+/, '');
      const linkPath = path.join(inputDir, relative);
      await fs.mkdir(path.dirname(linkPath), { recursive: true });
      try {
        await fs.symlink(originalPath, linkPath);
      } catch (error: any) {
        if (error?.code !== 'EEXIST') {
          throw error;
        }
      }
    }
  }

  private async runApplyJob(
    auth: AuthDto,
    id: string,
    config: MiniFilmConfig,
    dto: MiniFilmApplyJobCreateDto,
    rawAssets: Asset[],
    profiles: string[],
  ) {
    try {
      await this.ensureMiniFilmRuntimeDirs(config);
      await this.patchApplyJob(
        id,
        (job) => ({
          ...job,
          status: 'running',
          progress: this.applyProgress(job, {
            stage: 'rendering',
            message: 'Starting mini-film apply job',
          }),
          updatedAt: new Date().toISOString(),
        }),
        { emitProgress: true },
      );
      const job = await this.findApplyJob(id);
      if (!job.albumId) {
        throw new InternalServerErrorException('mini-film apply album was not created');
      }
      const importedAssetIds = [...(job.importedAssetIds ?? [])];
      const selectedProfiles = profiles.length > 0 ? profiles : [undefined];

      for (const asset of rawAssets) {
        for (const [profileIndex, profile] of selectedProfiles.entries()) {
          const currentFile = asset.originalFileName || path.basename(asset.originalPath);
          const currentProfile = profile ? path.parse(profile).name || profile : 'default';
          await this.patchApplyJob(
            id,
            (current) => ({
              ...current,
              progress: this.applyProgress(current, {
                stage: 'rendering',
                currentFile,
                currentProfile,
                message: `Rendering ${currentFile}`,
              }),
              updatedAt: new Date().toISOString(),
            }),
            { emitProgress: true },
          );

          const output = this.applyOutputPath(job.outputDir, asset, profile, profileIndex, config, dto);
          const args = ['apply', asset.originalPath, '--output', output, ...this.applyArgs(config, dto, profile)];
          await this.runProcess(config.binaryPath, args, (text) => void this.appendApplyLog(id, text), {
            env: this.miniFilmEnv(config),
          });
          const importedAssetId = await this.importGeneratedFileToAlbum(auth, output, job.albumId);
          if (importedAssetId && !importedAssetIds.includes(importedAssetId)) {
            importedAssetIds.push(importedAssetId);
          }
          await this.patchApplyJob(
            id,
            (current) => ({
              ...current,
              processed: current.processed + 1,
              importedAssetIds,
              progress: this.applyProgress(
                {
                  ...current,
                  processed: current.processed + 1,
                  importedAssetIds,
                },
                {
                  stage: 'rendering',
                  currentFile,
                  currentProfile,
                  message: `Imported ${path.basename(output)}`,
                },
              ),
              updatedAt: new Date().toISOString(),
            }),
            { emitProgress: true },
          );
        }
      }

      await this.patchApplyJob(
        id,
        (current) => ({
          ...current,
          status: 'completed',
          albumId: job.albumId,
          importedAssetIds,
          progress: this.applyProgress(
            {
              ...current,
              processed: current.total,
              importedAssetIds,
            },
            {
              stage: 'completed',
              message: 'mini-film apply completed',
              currentFile: undefined,
              currentProfile: undefined,
            },
          ),
          updatedAt: new Date().toISOString(),
        }),
        { emitProgress: true },
      );
    } catch (error: any) {
      await this.appendApplyLog(id, `${error?.message || error}\n`);
      await this.patchApplyJob(
        id,
        (job) => ({
          ...job,
          status: 'failed',
          error: error?.message || String(error),
          progress: this.applyProgress(job, {
            stage: 'failed',
            message: error?.message || String(error),
          }),
          updatedAt: new Date().toISOString(),
        }),
        { emitProgress: true },
      );
    }
  }

  private async runReviewImportJob(
    auth: AuthDto,
    id: string,
    config: MiniFilmConfig,
    dto: MiniFilmReviewSessionImportDto,
    publishAlbum: string,
    publishDir: string,
    albumId: string,
  ) {
    const importedFiles = new Set<string>();
    const importingFiles = new Set<string>();
    const seenFiles = new Map<string, { size: number; mtimeMs: number }>();
    let scanPromise: Promise<void> | undefined;
    const scan = async () => {
      scanPromise ??= this.importReadyReviewOutputs(
        auth,
        id,
        publishDir,
        albumId,
        importedFiles,
        importingFiles,
        seenFiles,
      ).finally(() => {
        scanPromise = undefined;
      });
      await scanPromise;
    };
    const scanSafely = () =>
      scan().catch(
        (error: any) => void this.appendReviewLog(id, `mini-film import scan failed: ${error?.message || error}\n`),
      );

    let interval: NodeJS.Timeout | undefined;
    try {
      const session = await this.findReviewSession(id);
      const args = this.reviewPublishArgs(session, config, publishAlbum, dto, true);
      await fs.mkdir(publishDir, { recursive: true });
      await this.ensureMiniFilmRuntimeDirs(config);
      await this.appendReviewLog(id, `$ ${[config.binaryPath, ...args].join(' ')}\n`);

      const publish = new Promise<void>((resolve, reject) => {
        const child = spawn(config.binaryPath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: this.miniFilmEnv(config),
        });
        this.reviewImportProcesses.set(id, child);
        child.stdout.on('data', (chunk) => {
          void this.appendReviewLog(id, chunk.toString());
          void scanSafely();
        });
        child.stderr.on('data', (chunk) => void this.appendReviewLog(id, chunk.toString()));
        child.on('error', (error) => reject(error));
        child.on('exit', (code, signal) => {
          if (code === 0) {
            resolve();
          } else {
            reject(
              new InternalServerErrorException(
                `mini-film exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`,
              ),
            );
          }
        });
      });

      interval = setInterval(() => void scanSafely(), IMPORT_SCAN_INTERVAL_MS);
      await scan();
      await publish;
      for (let index = 0; index < 3; index++) {
        await this.sleep(IMPORT_STABLE_DELAY_MS);
        await scan();
      }

      const updated = await this.findReviewSession(id);
      const importedAssetIds = updated.importedAssetIds ?? [];
      if (importedAssetIds.length === 0) {
        throw new BadRequestException(`No mini-film outputs were imported from ${publishDir}`);
      }

      await this.patchReviewSession(
        id,
        (current) => ({
          ...current,
          status: this.reviewProcesses.has(id) ? 'running' : 'imported',
          importedAlbumId: albumId,
          importedAssetIds,
          progress: this.withProgressStatus(current.progress, 'completed', 'mini-film review imported into Immich', {
            imported: importedAssetIds.length,
            processed: current.progress.total,
            percent: 1,
          }),
          updatedAt: new Date().toISOString(),
        }),
        { emitProgress: true },
      );
    } catch (error: any) {
      this.stopReviewImportProcess(id);
      void this.stopReviewLiveImportWatcher(id);
      await this.appendReviewLog(id, `${error?.message || error}\n`);
      await this.patchReviewSession(
        id,
        (session) => ({
          ...session,
          status: session.status === 'stopped' ? 'stopped' : 'failed',
          progress: this.withProgressStatus(session.progress, 'failed', error?.message || String(error)),
          updatedAt: new Date().toISOString(),
        }),
        { emitProgress: true },
      );
    } finally {
      if (interval) {
        clearInterval(interval);
      }
      this.reviewImportProcesses.delete(id);
    }
  }

  private reviewPublishArgs(
    session: StoredReviewSession,
    config: MiniFilmConfig,
    publishAlbum: string,
    dto: MiniFilmReviewSessionImportDto,
    progressEvents = false,
  ): string[] {
    const args = [
      'review-publish',
      ...(progressEvents ? ['--progress-events'] : []),
      '--state',
      session.statePath,
      '--input-root',
      session.inputDir,
      '--output-root',
      session.outputDir,
      '--album',
      publishAlbum,
      '--min-rating',
      String(dto.minRating ?? 0),
      ...this.publishArgs(config, dto),
    ];

    for (const label of dto.labels || []) {
      args.push('--label', label);
    }
    for (const tag of dto.tags || []) {
      args.push('--tag', tag);
    }
    if (dto.rerenderRaw) {
      args.push('--rerender-raw');
    }
    return args;
  }

  private startReviewLiveImportWatcher(auth: AuthDto, id: string, publishDir: string, albumId: string) {
    const oldWatcher = this.reviewLiveImportWatchers.get(id);
    if (oldWatcher) {
      void this.stopReviewLiveImportWatcher(id);
    }

    const watcherState: MiniFilmLiveImportWatcher = {
      watcher: chokidar.watch(publishDir, {
        ignoreInitial: false,
      }),
      auth,
      publishDir,
      albumId,
      importedFiles: new Set(),
      importingFiles: new Set(),
      seenFiles: new Map(),
      completedPublishJobs: new Set(),
      publishFailed: false,
      stopped: false,
    };

    const scan = () => {
      void this.scanReviewLiveImportWatcher(id).catch((error) => this.logLiveImportError(id, error));
    };
    watcherState.watcher.on('add', scan);
    watcherState.watcher.on('change', scan);
    watcherState.watcher.on('unlink', scan);
    watcherState.watcher.on('error', (error) => void this.logLiveImportError(id, error));
    this.reviewLiveImportWatchers.set(id, watcherState);
    scan();
  }

  private async stopReviewLiveImportWatcher(id: string) {
    const watcherState = this.reviewLiveImportWatchers.get(id);
    if (!watcherState) {
      return;
    }
    watcherState.stopped = true;
    this.reviewLiveImportWatchers.delete(id);
    await watcherState.watcher.close().catch((error: any) => {
      this.logger.warn(`Failed to close mini-film live import watcher ${id}: ${error?.message || error}`);
    });
  }

  private async scanReviewLiveImportWatcher(id: string) {
    const watcherState = this.reviewLiveImportWatchers.get(id);
    if (!watcherState || watcherState.stopped) {
      return;
    }

    watcherState.scanPromise ??= this.importReadyReviewOutputs(
      watcherState.auth,
      id,
      watcherState.publishDir,
      watcherState.albumId,
      watcherState.importedFiles,
      watcherState.importingFiles,
      watcherState.seenFiles,
    ).finally(() => {
      watcherState.scanPromise = undefined;
    });
    await watcherState.scanPromise;
  }

  private triggerReviewLiveImportScan(id: string) {
    void this.scanReviewLiveImportWatcher(id).catch((error) => this.logLiveImportError(id, error));
  }

  private async logLiveImportError(id: string, error: unknown) {
    await this.appendReviewLog(
      id,
      `mini-film live import scan failed: ${error instanceof Error ? error.message : error}\n`,
    ).catch(() => {});
  }

  private markReviewLivePublishState(id: string, completedPublishJobIds: string[], failed: boolean) {
    const watcherState = this.reviewLiveImportWatchers.get(id);
    if (!watcherState) {
      return;
    }

    watcherState.publishFailed ||= failed;
    this.triggerReviewLiveImportScan(id);

    const hasNewCompletedPublishJob = completedPublishJobIds.some((publishJobId) => {
      if (watcherState.completedPublishJobs.has(publishJobId)) {
        return false;
      }
      watcherState.completedPublishJobs.add(publishJobId);
      return true;
    });

    if (hasNewCompletedPublishJob) {
      void this.completeReviewLiveImportIfReady(id);
    }
  }

  private async completeReviewLiveImportIfReady(id: string) {
    const watcherState = this.reviewLiveImportWatchers.get(id);
    if (!watcherState || watcherState.stopped || watcherState.publishFailed) {
      return;
    }

    watcherState.completionPromise ??= this.finishReviewLiveImportWhenStable(id, watcherState).finally(() => {
      const latestWatcherState = this.reviewLiveImportWatchers.get(id);
      if (latestWatcherState) {
        latestWatcherState.completionPromise = undefined;
      }
    });
    await watcherState.completionPromise;
  }

  private async finishReviewLiveImportWhenStable(id: string, watcherState: MiniFilmLiveImportWatcher) {
    await this.sleep(IMPORT_STABLE_DELAY_MS);
    await this.scanReviewLiveImportWatcher(id);
    await this.sleep(IMPORT_STABLE_DELAY_MS);
    await this.scanReviewLiveImportWatcher(id);

    const session = await this.findReviewSession(id).catch(() => null);
    if (!session || watcherState.stopped || session.status !== 'running') {
      return;
    }

    const importedAssetIds = session.importedAssetIds ?? [];
    if (importedAssetIds.length === 0) {
      return;
    }

    await this.patchReviewSession(
      id,
      (current) => ({
        ...current,
        status: 'running',
        importedAlbumId: watcherState.albumId,
        importedAssetIds,
        progress: this.withProgressStatus(current.progress, 'completed', 'mini-film review imported into Immich', {
          imported: importedAssetIds.length,
          processed: current.progress.total,
          percent: 1,
          currentFile: undefined,
          currentProfile: undefined,
        }),
        updatedAt: new Date().toISOString(),
      }),
      { emitProgress: true },
    );
  }

  private async importReadyReviewOutputs(
    auth: AuthDto,
    id: string,
    publishDir: string,
    albumId: string,
    importedFiles: Set<string>,
    importingFiles: Set<string>,
    seenFiles: Map<string, { size: number; mtimeMs: number }>,
  ) {
    const files = await this.collectImportableImages(publishDir);
    for (const file of files) {
      const resolved = path.resolve(file);
      if (importedFiles.has(resolved) || importingFiles.has(resolved)) {
        continue;
      }
      if (!(await this.isStableImportFile(resolved, seenFiles))) {
        continue;
      }

      importingFiles.add(resolved);
      try {
        const assetId = await this.importGeneratedFileToAlbum(auth, resolved, albumId, { checkStable: false });
        if (!assetId) {
          continue;
        }
        importedFiles.add(resolved);
        await this.patchReviewSession(
          id,
          (current) => {
            const importedAssetIds = current.importedAssetIds ?? [];
            const nextImportedAssetIds = importedAssetIds.includes(assetId)
              ? importedAssetIds
              : [...importedAssetIds, assetId];
            return {
              ...current,
              importedAssetIds: nextImportedAssetIds,
              progress: this.withProgressStatus(current.progress, 'importing', `Imported ${path.basename(resolved)}`, {
                imported: nextImportedAssetIds.length,
              }),
              updatedAt: new Date().toISOString(),
            };
          },
          { emitProgress: true },
        );
      } finally {
        importingFiles.delete(resolved);
      }
    }
  }

  private async importGeneratedFileToAlbum(
    auth: AuthDto,
    file: string,
    albumId: string,
    options: { checkStable?: boolean } = {},
  ): Promise<string | undefined> {
    if (options.checkStable !== false && !(await this.isStableImportFile(file))) {
      return;
    }

    const assetService = BaseService.create(AssetMediaService, this);
    const result = await assetService.importLocalAsset(auth, file, path.basename(file), {
      jobPriority: MINI_FILM_JOB_PRIORITY,
    });
    if (!result.id) {
      return;
    }

    await BaseService.create(AlbumService, this).addAssets(auth, albumId, { ids: [result.id] });
    await this.queueMiniFilmThumbnail(result.id);
    await this.notifyAlbumAssetAdded(auth, albumId, result.id);
    return result.id;
  }

  private async queueMiniFilmThumbnail(assetId: string) {
    await this.jobRepository.queue({
      name: JobName.AssetGenerateThumbnails,
      data: { id: assetId, source: 'upload', notify: true, priority: MINI_FILM_JOB_PRIORITY },
    });
  }

  private async notifyAlbumAssetAdded(auth: AuthDto, albumId: string, assetId: string) {
    const [asset] = await this.assetRepository.getByIdsWithAllRelationsButStacks([assetId]);
    if (!asset) {
      return;
    }
    this.websocketRepository.clientSend('on_album_asset_add', auth.user.id, {
      albumId,
      asset: mapAsset(asset, { auth }),
    });
  }

  private startReviewHistoryWatcher(id: string, outputDir: string, historyPath: string) {
    const oldWatcher = this.reviewHistoryWatchers.get(id);
    if (oldWatcher) {
      void oldWatcher.watcher.close();
    }

    const watcherState: MiniFilmHistoryWatcher = {
      watcher: chokidar.watch(outputDir, {
        depth: 0,
        ignoreInitial: false,
      }),
      offset: 0,
      buffer: '',
      workItems: new Map(),
      publishJobs: new Map(),
      imageIds: new Set(),
      publishCompleted: false,
      publishFailed: false,
    };

    const onHistoryChange = (file: string) => {
      if (path.resolve(file) === path.resolve(historyPath)) {
        void this.readReviewHistory(id, watcherState, historyPath);
      }
    };

    watcherState.watcher.on('add', onHistoryChange);
    watcherState.watcher.on('change', onHistoryChange);
    watcherState.watcher.on('error', (error) => {
      void this.appendReviewLog(id, `mini-film history watcher failed: ${error}\n`);
    });
    this.reviewHistoryWatchers.set(id, watcherState);
    void this.readReviewHistory(id, watcherState, historyPath);
  }

  private async stopReviewHistoryWatcher(id: string) {
    const watcherState = this.reviewHistoryWatchers.get(id);
    if (!watcherState) {
      return;
    }
    this.reviewHistoryWatchers.delete(id);
    await watcherState.watcher.close().catch((error: any) => {
      this.logger.warn(`Failed to close mini-film history watcher ${id}: ${error?.message || error}`);
    });
  }

  private async stopActiveReviewSessionsForUser(userId: string) {
    const state = await this.getState();
    const sessions = Object.values(state.reviewSessions).filter(
      (session) =>
        session.userId === userId &&
        (session.status === 'running' ||
          session.status === 'importing' ||
          this.reviewProcesses.has(session.id) ||
          this.reviewImportProcesses.has(session.id) ||
          this.reviewHistoryWatchers.has(session.id) ||
          this.reviewLiveImportWatchers.has(session.id)),
    );

    for (const session of sessions) {
      this.stopReviewImportProcess(session.id);
      this.stopReviewProcess(session.id);
      await Promise.all([this.stopReviewHistoryWatcher(session.id), this.stopReviewLiveImportWatcher(session.id)]);
      await this.patchReviewSession(
        session.id,
        (current) => ({
          ...current,
          status: current.status === 'failed' || current.status === 'imported' ? current.status : 'stopped',
          progress:
            current.status === 'failed' || current.status === 'imported'
              ? current.progress
              : this.withProgressStatus(
                  current.progress,
                  'completed',
                  'mini-film review stopped because a new review was started',
                  { currentFile: undefined, currentProfile: undefined },
                ),
          updatedAt: new Date().toISOString(),
        }),
        { emitProgress: true },
      );
    }
  }

  private async readReviewHistory(id: string, watcherState: MiniFilmHistoryWatcher, historyPath: string) {
    const stat = await fs.stat(historyPath).catch(() => null);
    if (!stat?.isFile()) {
      return;
    }

    if (stat.size < watcherState.offset) {
      watcherState.offset = 0;
      watcherState.buffer = '';
      watcherState.workItems.clear();
      watcherState.publishJobs.clear();
      watcherState.imageIds.clear();
      watcherState.publishCompleted = false;
      watcherState.publishFailed = false;
    }

    if (stat.size === watcherState.offset) {
      return;
    }

    const length = stat.size - watcherState.offset;
    const file = await fs.open(historyPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, watcherState.offset);
      watcherState.offset = stat.size;
      watcherState.buffer += buffer.toString('utf8');
    } finally {
      await file.close();
    }

    await this.consumeReviewHistory(id, watcherState);
  }

  private async consumeReviewHistory(id: string, watcherState: MiniFilmHistoryWatcher) {
    const blocks = watcherState.buffer.split(/\r?\n\s*\r?\n/);
    watcherState.buffer = blocks.pop() ?? '';

    let changed = false;
    for (const block of blocks) {
      changed = this.parseReviewHistoryBlock(block, watcherState) || changed;
    }

    if (!changed) {
      return;
    }

    await this.patchReviewSession(
      id,
      (current) => ({
        ...current,
        progress: this.reviewProgressFromHistory(current, watcherState),
        updatedAt: new Date().toISOString(),
      }),
      { emitProgress: true },
    );

    if (watcherState.publishJobs.size > 0) {
      const completedPublishJobIds = [...watcherState.publishJobs.values()]
        .filter((item) => item.status === 'done')
        .map((item) => item.id);
      this.markReviewLivePublishState(id, completedPublishJobIds, watcherState.publishFailed);
    }
  }

  private parseReviewHistoryBlock(block: string, watcherState: MiniFilmHistoryWatcher): boolean {
    const [header, ...detailLines] = block
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!header) {
      return false;
    }

    const title = header.split(' | ').slice(1).join(' | ').trim();
    if (!title) {
      return false;
    }

    const imageMatch = /^review image (.*) #(\d+)$/.exec(title);
    if (imageMatch) {
      const [, file, imageId] = imageMatch;
      watcherState.imageIds.add(imageId);
      watcherState.currentFile = file;
      watcherState.message = detailLines.includes('preview queued')
        ? `Queued preview for ${file}`
        : `Discovered ${file}`;
      if (detailLines.includes('preview queued')) {
        return this.setReviewHistoryWorkItem(watcherState, `preview:${imageId}`, {
          key: `preview:${imageId}`,
          file,
          status: 'queued',
        });
      }
      return true;
    }

    const previewMatch = /^review preview changed (.*) #(\d+)$/.exec(title);
    if (previewMatch) {
      const [, file, imageId] = previewMatch;
      const status = this.parseReviewHistoryStatus(detailLines);
      return this.setReviewHistoryWorkItem(watcherState, `preview:${imageId}`, {
        key: `preview:${imageId}`,
        file,
        status: status ?? 'queued',
      });
    }

    const renderMatch = /^review render changed (.*) #(\d+) \[(.*)]$/.exec(title);
    if (renderMatch) {
      const [, file, imageId, profile] = renderMatch;
      const status = this.parseReviewHistoryStatus(detailLines);
      return this.setReviewHistoryWorkItem(watcherState, `render:${imageId}:${profile}`, {
        key: `render:${imageId}:${profile}`,
        file,
        profile,
        status: status ?? 'queued',
      });
    }

    const publishStartedMatch = /^review publish job #(\d+) started$/.exec(title);
    if (publishStartedMatch) {
      const [, publishId] = publishStartedMatch;
      const album = this.parseHistoryValue(detailLines, 'album');
      return this.setReviewPublishHistoryWorkItem(watcherState, {
        id: publishId,
        album,
        status: 'running',
        processed: 0,
        total: 0,
        linked: 0,
      });
    }

    const publishChangedMatch = /^review publish job #(\d+) changed$/.exec(title);
    if (publishChangedMatch) {
      const [, publishId] = publishChangedMatch;
      const existing = watcherState.publishJobs.get(publishId);
      const status = this.parseReviewPublishStatus(detailLines) ?? existing?.status ?? 'running';
      const processed = this.parseHistoryNumber(detailLines, 'processed') ?? existing?.processed ?? 0;
      const total = this.parseHistoryNumber(detailLines, 'total') ?? existing?.total ?? 0;
      const linked = this.parseHistoryNumber(detailLines, 'linked') ?? existing?.linked ?? 0;
      const current = this.parseHistoryValue(detailLines, 'current') ?? existing?.current;
      return this.setReviewPublishHistoryWorkItem(watcherState, {
        id: publishId,
        album: existing?.album,
        status,
        processed,
        total,
        linked,
        current,
      });
    }

    return false;
  }

  private setReviewHistoryWorkItem(
    watcherState: MiniFilmHistoryWatcher,
    key: string,
    item: MiniFilmHistoryWorkItem,
  ): boolean {
    const existing = watcherState.workItems.get(key);
    if (
      existing &&
      existing.file === item.file &&
      existing.profile === item.profile &&
      existing.status === item.status
    ) {
      return false;
    }

    watcherState.workItems.set(key, item);
    watcherState.currentFile = item.file;
    watcherState.currentProfile = item.profile;
    watcherState.message = `${item.file}${item.profile ? ` [${item.profile}]` : ''}: ${item.status}`;
    return true;
  }

  private setReviewPublishHistoryWorkItem(
    watcherState: MiniFilmHistoryWatcher,
    item: MiniFilmPublishHistoryWorkItem,
  ): boolean {
    const existing = watcherState.publishJobs.get(item.id);
    if (
      existing &&
      existing.album === item.album &&
      existing.status === item.status &&
      existing.processed === item.processed &&
      existing.total === item.total &&
      existing.linked === item.linked &&
      existing.current === item.current
    ) {
      return false;
    }

    watcherState.publishJobs.set(item.id, item);
    watcherState.currentFile = item.current;
    watcherState.currentProfile = undefined;
    watcherState.message =
      item.status === 'done'
        ? 'mini-film publish completed'
        : item.status === 'failed'
          ? 'mini-film publish failed'
          : item.current
            ? `Publishing ${item.current}`
            : 'Publishing mini-film review output';
    watcherState.publishCompleted ||= item.status === 'done';
    watcherState.publishFailed ||= item.status === 'failed';
    return true;
  }

  private parseReviewHistoryStatus(lines: string[]): MiniFilmHistoryStatus | undefined {
    const status = this.parseHistoryValue(lines, 'status');
    return this.isReviewHistoryStatus(status) ? status : undefined;
  }

  private parseReviewPublishStatus(lines: string[]): MiniFilmPublishStatus | undefined {
    const status = this.parseHistoryValue(lines, 'status');
    return status === 'running' || status === 'done' || status === 'failed' ? status : undefined;
  }

  private parseHistoryValue(lines: string[], label: string): string | undefined {
    const line = lines.find((line) => line.startsWith(`${label}: `));
    const rawValue = line?.slice(label.length + 2).trim();
    const value = rawValue
      ?.split(/\s+->\s+/)
      .pop()
      ?.trim();
    return value && value !== 'none' ? value : undefined;
  }

  private parseHistoryNumber(lines: string[], label: string): number | undefined {
    const value = this.parseHistoryValue(lines, label);
    const parsed = value ? Number(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private isReviewHistoryStatus(status: string | undefined): status is MiniFilmHistoryStatus {
    return (
      status === 'missing' ||
      status === 'queued' ||
      status === 'processing' ||
      status === 'done' ||
      status === 'failed' ||
      status === 'running' ||
      status === 'skipped'
    );
  }

  private reviewProgressFromHistory(
    session: StoredReviewSession,
    watcherState: MiniFilmHistoryWatcher,
  ): MiniFilmProgress {
    const publishItems = [...watcherState.publishJobs.values()];
    if (publishItems.length > 0) {
      const hasRunningPublish = publishItems.some((item) => item.status === 'running');
      const processed = publishItems.reduce(
        (sum, item) => sum + (item.status === 'done' ? Math.max(item.processed, item.total) : item.processed),
        0,
      );
      const total = publishItems.reduce((sum, item) => sum + Math.max(item.processed, item.total), 0);
      const activePublish = publishItems.find((item) => item.status === 'running') ?? publishItems.at(-1);
      return {
        ...session.progress,
        stage:
          session.status === 'failed' || watcherState.publishFailed
            ? 'failed'
            : session.status === 'imported'
              ? 'completed'
              : hasRunningPublish
                ? 'importing'
                : 'completed',
        processed,
        total,
        percent: this.progressPercent(processed, total),
        currentFile: activePublish?.current,
        currentProfile: undefined,
        message: watcherState.message ?? 'Publishing mini-film review output',
        updatedAt: new Date().toISOString(),
        imported: session.importedAssetIds?.length ?? 0,
        skipped: session.skippedAssets.length,
      };
    }

    const workItems = [...watcherState.workItems.values()];
    const processed = workItems.filter((item) => this.isTerminalReviewHistoryStatus(item.status)).length;
    const total = Math.max(workItems.length, watcherState.imageIds.size);
    const stage =
      session.status === 'failed'
        ? 'failed'
        : session.status === 'imported'
          ? 'completed'
          : session.status === 'importing'
            ? 'importing'
            : total === 0
              ? 'discovering'
              : 'rendering';

    return {
      ...session.progress,
      stage,
      processed,
      total,
      percent: this.progressPercent(processed, total),
      currentFile: watcherState.currentFile,
      currentProfile: watcherState.currentProfile,
      message: watcherState.message ?? `Discovered ${watcherState.imageIds.size} image(s)`,
      updatedAt: new Date().toISOString(),
      imported: session.importedAssetIds?.length ?? 0,
      skipped: session.skippedAssets.length,
    };
  }

  private isTerminalReviewHistoryStatus(status: MiniFilmHistoryStatus): boolean {
    return status === 'done' || status === 'failed' || status === 'skipped';
  }

  private applyProgress(job: StoredApplyJob, patch: Partial<MiniFilmProgress>): MiniFilmProgress {
    const processed = patch.processed ?? job.processed;
    const total = patch.total ?? job.total;
    return {
      ...job.progress,
      ...patch,
      processed,
      total,
      percent: patch.percent ?? this.progressPercent(processed, total),
      currentFile: 'currentFile' in patch ? patch.currentFile : job.progress.currentFile,
      currentProfile: 'currentProfile' in patch ? patch.currentProfile : job.progress.currentProfile,
      updatedAt: new Date().toISOString(),
      imported: job.importedAssetIds?.length ?? 0,
      skipped: job.skippedAssets.length,
    };
  }

  private withProgressStatus(
    progress: MiniFilmProgress,
    stage: MiniFilmProgress['stage'],
    message: string,
    patch: Partial<MiniFilmProgress> = {},
  ): MiniFilmProgress {
    const processed = patch.processed ?? progress.processed;
    const total = patch.total ?? progress.total;
    return {
      ...progress,
      ...patch,
      stage,
      message,
      processed,
      total,
      percent: patch.percent ?? this.progressPercent(processed, total),
      updatedAt: new Date().toISOString(),
    };
  }

  private progressPercent(processed: number, total: number): number {
    if (total <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(1, processed / total));
  }

  private emitMiniFilmProgress(mode: MiniFilmMode, item: StoredApplyJob | StoredReviewSession) {
    const albumId = mode === 'apply' ? (item as StoredApplyJob).albumId : (item as StoredReviewSession).importedAlbumId;
    this.websocketRepository.clientSend('on_mini_film_progress', item.userId, {
      mode,
      id: item.id,
      status: item.status,
      progress: item.progress,
      albumId,
      importedAssetIds: item.importedAssetIds,
    });
  }

  private applyOutputPath(
    outputDir: string,
    asset: Asset,
    profile: string | undefined,
    profileIndex: number,
    config: MiniFilmConfig,
    dto: MiniFilmApplyJobCreateDto,
  ) {
    const extension = (dto.outputFormat ?? config.outputFormat) === 'tiff' ? 'tif' : 'jpg';
    const stem = path.parse(asset.originalFileName).name || path.parse(asset.originalPath).name || asset.id;
    const profileStem = profile ? path.parse(profile).name || 'profile' : 'default';
    const filename = sanitize(
      `${stem}__${String(profileIndex + 1).padStart(2, '0')}__${profileStem}__${asset.id.slice(0, 8)}.${extension}`,
    );
    return path.join(outputDir, filename);
  }

  private async collectImportableImages(root: string): Promise<string[]> {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: any) => {
      if (error?.code === 'ENOENT') {
        return [];
      }
      throw error;
    });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(root, entry.name);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (stat?.isDirectory()) {
        if (entry.name === '.mini-film-gallery-thumbnails') {
          continue;
        }
        files.push(...(await this.collectImportableImages(fullPath)));
      } else if (stat?.isFile() && mimeTypes.isImage(fullPath)) {
        files.push(fullPath);
      }
    }
    return files.sort();
  }

  private daemonArgs(config: MiniFilmConfig, options: MiniFilmCommonOptions): string[] {
    return [
      ...this.sharedMiniFilmArgs(config, options, {
        jobs: true,
        outputFormat: true,
        gallery: true,
        progressive: 'daemon',
      }),
    ];
  }

  private publishArgs(config: MiniFilmConfig, options: MiniFilmCommonOptions): string[] {
    return [
      ...this.sharedMiniFilmArgs(config, options, {
        jobs: true,
        outputFormat: true,
        gallery: true,
        progressive: 'daemon',
      }),
    ];
  }

  private applyArgs(config: MiniFilmConfig, options: MiniFilmCommonOptions, profile: string | undefined): string[] {
    return [
      ...(profile ? ['--profile', profile] : []),
      ...this.sharedMiniFilmArgs(config, options, {
        jobs: false,
        outputFormat: false,
        gallery: false,
        progressive: 'apply',
      }),
    ];
  }

  private sharedMiniFilmArgs(
    config: MiniFilmConfig,
    options: MiniFilmCommonOptions,
    flags: { jobs: boolean; outputFormat: boolean; gallery: boolean; progressive: 'daemon' | 'apply' },
  ): string[] {
    const args: string[] = [];
    this.pushOptional(args, '--profiles-root', this.effectiveProfilesRoot(config));
    this.pushOptional(args, '--hald-dir', options.haldDir?.trim() || this.effectiveHaldDir(config));
    this.pushOptional(args, '--lcp-root', options.lcpRoot ?? config.lcpRoot);
    this.pushOptional(args, '--rawtherapee', options.rawtherapeePath ?? config.rawtherapeePath);
    this.pushOptional(args, '--convert', options.convertPath ?? config.convertPath);
    this.pushOptional(
      args,
      '--color-noise-iso-threshold',
      String(options.colorNoiseIsoThreshold ?? config.colorNoiseIsoThreshold),
    );
    this.pushOptional(args, '--jpg-quality', String(options.jpgQuality ?? config.jpgQuality));
    this.pushOptional(args, '--jpeg-subsampling', options.jpegSubsampling ?? config.jpegSubsampling);

    const longEdge = options.longEdge ?? config.longEdge;
    if (longEdge > 0) {
      args.push('--long-edge', String(longEdge));
    }

    const lensCorrections = (options.lensCorrections ?? config.lensCorrections).trim();
    if (lensCorrections) {
      args.push(`--lens-corrections=${lensCorrections}`);
    }
    const grainPreset = options.grainPreset ?? config.grainPreset;
    if (grainPreset) {
      args.push('--grain-preset', grainPreset);
    }
    const grain = (options.grain ?? config.grain).trim();
    if (grain) {
      args.push('--grain', grain);
    }
    if (options.noGrain ?? config.noGrain) {
      args.push('--no-grain');
    }
    if (options.stripMetadata ?? config.stripMetadata) {
      args.push('--strip-metadata');
    }
    if (options.progressive ?? config.progressive) {
      args.push(flags.progressive === 'apply' ? '--progressive-jpeg' : '--progressive');
    }

    if (flags.outputFormat) {
      args.push('--output-format', options.outputFormat ?? config.outputFormat);
    }
    if (flags.jobs) {
      args.push('--jobs', String(this.resolveJobs(config, options.jobs)));
    }
    if (flags.gallery) {
      const gallery = options.gallery ?? config.gallery;
      if (gallery) {
        args.push('--gallery', gallery);
      }
      args.push(
        '--gallery-thumbnail-long-edge',
        String(options.galleryThumbnailLongEdge ?? config.galleryThumbnailLongEdge),
        '--gallery-columns',
        String(options.galleryColumns ?? config.galleryColumns),
      );
    }

    return args;
  }

  private profileArgs(profiles: string[]): string[] {
    return profiles.flatMap((profile) => ['--profile', profile]);
  }

  private resolveJobs(config: MiniFilmConfig, requested: number | undefined): number {
    const jobs = requested ?? config.defaultJobs;
    if (jobs > config.maxJobs) {
      throw new BadRequestException(`mini-film jobs cannot exceed ${config.maxJobs}`);
    }
    return jobs;
  }

  private pushOptional(args: string[], flag: string, value: string | undefined) {
    if (value?.trim()) {
      args.push(flag, value);
    }
  }

  private async resolveProfiles(config: MiniFilmConfig, selectedProfiles: string[] | undefined): Promise<string[]> {
    const selectors = selectedProfiles?.length ? selectedProfiles : config.defaultProfiles;
    if (selectors.length === 0) {
      return [];
    }

    const leaves = await this.collectProfileLeaves(config);
    const bySelector = new Map<string, MiniFilmProfileLeafDto>();
    for (const leaf of leaves) {
      bySelector.set(leaf.path, leaf);
      bySelector.set(path.resolve(leaf.path), leaf);
      bySelector.set(leaf.relative, leaf);
      bySelector.set(leaf.name, leaf);
    }

    const allowedProfiles = new Set<string>();
    for (const selector of config.allowedProfiles) {
      const leaf = bySelector.get(selector) || bySelector.get(path.resolve(selector));
      allowedProfiles.add(leaf?.path ?? selector);
    }

    return Promise.all(
      selectors.map(async (selector) => {
        const leaf = bySelector.get(selector) || bySelector.get(path.resolve(selector));
        const resolved = leaf?.path ?? selector;
        if (allowedProfiles.size > 0 && !allowedProfiles.has(resolved)) {
          throw new BadRequestException(`mini-film profile is not allowed: ${selector}`);
        }
        if (!leaf && path.isAbsolute(resolved) && !(await this.fileExists(resolved))) {
          throw new BadRequestException(`mini-film profile does not exist: ${selector}`);
        }
        return resolved;
      }),
    );
  }

  private async buildProfileTree(config: MiniFilmConfig, includeAll = false): Promise<MiniFilmProfileTreeDto> {
    const root = await this.resolveEmulationRoot(config);
    if (!root) {
      return { root: '', count: 0, children: [] };
    }
    const leaves = await this.collectProfileLeaves(config);
    const allowed = new Set(config.allowedProfiles);
    const tree: ProfileNodeMutable = { profiles: [], children: new Map() };

    for (const leaf of leaves) {
      if (
        !includeAll &&
        allowed.size > 0 &&
        !allowed.has(leaf.path) &&
        !allowed.has(leaf.relative) &&
        !allowed.has(leaf.name)
      ) {
        continue;
      }
      this.insertProfile(tree, this.profileNameParts(leaf.name), leaf);
    }

    const children = this.childrenIntoNodes(tree.children);
    return { root, count: this.countLeaves(children), children };
  }

  private async collectProfileLeaves(config: MiniFilmConfig): Promise<MiniFilmProfileLeafDto[]> {
    const root = await this.resolveEmulationRoot(config);
    if (!root) {
      return [];
    }
    const files = await this.collectXmpProfiles(root);
    return files.map((file) => {
      const relative = path.relative(root, file);
      const name = this.profileDisplayNameFromRelative(relative);
      return { name, path: file, relative };
    });
  }

  private effectiveProfilesRoot(config: MiniFilmConfig): string {
    return (config.profilesRoot || process.env.MINI_FILM_PROFILES_ROOT || '').trim();
  }

  private effectiveHaldDir(config: MiniFilmConfig): string {
    return config.haldDir.trim() || path.join(path.resolve(config.workRoot), 'hald');
  }

  private reviewUnavailableMessage(session: StoredReviewSession): string {
    const details = session.logs.trim().split('\n').filter(Boolean).slice(-4).join('\n');
    return details
      ? `mini-film review session is ${session.status}: ${details}`
      : `mini-film review session is ${session.status}`;
  }

  private async resolveEmulationRoot(config: MiniFilmConfig): Promise<string> {
    const rawRoot = this.effectiveProfilesRoot(config);
    if (!rawRoot) {
      return '';
    }
    const root = path.resolve(rawRoot);
    const direct = path.join(root, 'emulations');
    if (await this.isDirectory(direct)) {
      return direct;
    }
    if (path.basename(root).toLowerCase() === 'emulations' && (await this.isDirectory(root))) {
      return root;
    }
    try {
      const canonical = await fs.realpath(root);
      const sibling = path.join(path.dirname(canonical), 'emulations');
      if (await this.isDirectory(sibling)) {
        return sibling;
      }
    } catch {
      // Fall through and let the scanner return an empty tree.
    }
    return (await this.isDirectory(root)) ? root : '';
  }

  private async collectXmpProfiles(root: string): Promise<string[]> {
    const profiles: string[] = [];
    const visited = new Set<string>();
    const walk = async (directory: string) => {
      let realDirectory: string;
      try {
        realDirectory = await fs.realpath(directory);
      } catch {
        return;
      }
      if (visited.has(realDirectory)) {
        return;
      }
      visited.add(realDirectory);

      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (!stat) {
          continue;
        }
        if (stat.isDirectory()) {
          await walk(fullPath);
        } else if (stat.isFile() && path.extname(entry.name).toLowerCase() === '.xmp') {
          profiles.push(fullPath);
        }
      }
    };

    await walk(root);
    return profiles.sort();
  }

  private insertProfile(node: ProfileNodeMutable, parts: string[], profile: MiniFilmProfileLeafDto) {
    const [part, ...rest] = parts;
    if (!part) {
      node.profiles.push(profile);
      return;
    }
    let child = node.children.get(part);
    if (!child) {
      child = { profiles: [], children: new Map() };
      node.children.set(part, child);
    }
    this.insertProfile(child, rest, profile);
  }

  private childrenIntoNodes(children: Map<string, ProfileNodeMutable>): MiniFilmProfileNodeDto[] {
    return [...children.entries()]
      .sort(([left], [right]) => this.compareProfilePart(left, right))
      .map(([label, child]) => ({
        label,
        profiles: child.profiles,
        children: this.childrenIntoNodes(child.children),
      }));
  }

  private countLeaves(nodes: MiniFilmProfileNodeDto[]): number {
    return nodes.reduce((count, node) => count + node.profiles.length + this.countLeaves(node.children), 0);
  }

  private profileDisplayNameFromRelative(relative: string): string {
    return (path.parse(relative).name || relative).trim();
  }

  private profileNameParts(name: string): string[] {
    const parts = name
      .replaceAll(/[_\-/.]/g, ' ')
      .split(/\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    return parts.length > 0 ? parts : ['Profile'];
  }

  private compareProfilePart(left: string, right: string): number {
    if (left < right) {
      return -1;
    }
    if (left > right) {
      return 1;
    }
    return 0;
  }

  private variantSortKey(label: string): string {
    const parts = this.profileNameParts(label);
    const markerParts: string[] = [];
    const nonGrainyMarkers: string[] = [];
    for (const part of parts) {
      const marker = this.normalizeVariantMarker(part);
      if (marker) {
        markerParts.push(marker);
        if (marker !== 'grainy') {
          nonGrainyMarkers.push(marker);
        }
      }
    }

    let variantGroup = 0;
    let variantMarkersKey = '';
    let grainyPosition = 0;
    if (nonGrainyMarkers.length === 0) {
      if (markerParts.length > 0) {
        variantGroup = 1;
        variantMarkersKey = 'grainy';
        grainyPosition = 1;
      }
    } else {
      nonGrainyMarkers.sort((left, right) => this.variantMarkerRank(left) - this.variantMarkerRank(right));
      variantGroup = Math.min(this.variantMarkerRank(nonGrainyMarkers[0]), 999);
      variantMarkersKey = nonGrainyMarkers.join(' ');
      grainyPosition = markerParts.includes('grainy') ? 1 : 0;
    }

    const normalized = parts
      .filter((part) => !this.normalizeVariantMarker(part))
      .map((part) => this.naturalSortPart(part))
      .join(' ')
      .toLowerCase();
    return `${normalized}\0${String(variantGroup).padStart(3, '0')}\0${variantMarkersKey}\0${grainyPosition}\0${label.toLowerCase()}`;
  }

  private normalizeVariantMarker(part: string): string | undefined {
    const normalized = part.replaceAll(/^\++|\++$/g, '').toLowerCase();
    if (normalized.length === 0) {
      return 'plus';
    }
    const known = new Set([
      'grainy',
      'plus',
      'hc',
      'faded',
      'fade',
      'warm',
      'cool',
      'vibrant',
      'muted',
      'contrast',
      'contrasty',
      'expired',
    ]);
    if (!known.has(normalized)) {
      return;
    }
    return normalized === 'fade' ? 'faded' : normalized;
  }

  private variantMarkerRank(marker: string): number {
    const ranks: Record<string, number> = {
      grainy: 1,
      faded: 2,
      plus: 3,
      hc: 4,
      warm: 5,
      cool: 6,
      vibrant: 7,
      muted: 8,
      contrast: 9,
      contrasty: 10,
      expired: 11,
    };
    return ranks[marker] ?? 98;
  }

  private naturalSortPart(part: string): string {
    const version = /^v(\d+)$/i.exec(part)?.[1];
    if (version) {
      return `v${String(Number(version)).padStart(6, '0')}`;
    }
    if (/^\d+$/.test(part)) {
      return String(Number(part)).padStart(6, '0');
    }
    return part;
  }

  private async allocatePort(start: number, end: number): Promise<number> {
    for (let port = start; port <= end; port++) {
      if (await this.canListen(port)) {
        return port;
      }
    }
    throw new BadRequestException(`No free mini-film review ports in ${start}-${end}`);
  }

  private canListen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });
  }

  private runProcess(
    binary: string,
    args: string[],
    onOutput: (text: string) => void,
    options: { env?: NodeJS.ProcessEnv } = {},
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      onOutput(`$ ${[binary, ...args].join(' ')}\n`);
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: options.env });
      child.stdout.on('data', (chunk) => onOutput(chunk.toString()));
      child.stderr.on('data', (chunk) => onOutput(chunk.toString()));
      child.on('error', (error) => reject(error));
      child.on('exit', (code, signal) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new InternalServerErrorException(`mini-film exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`),
          );
        }
      });
    });
  }

  private publishAlbumName(value: string): string {
    const album = value.trim() || 'published';
    if (path.isAbsolute(album) || album.split(/[\\/]+/).includes('..')) {
      throw new BadRequestException('mini-film publish album must be a relative folder');
    }
    return album;
  }

  private resolveInside(root: string, relative: string): string {
    const resolvedRoot = path.resolve(root);
    const resolved = path.resolve(resolvedRoot, relative);
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new BadRequestException('mini-film path escapes the session output folder');
    }
    return resolved;
  }

  private async ensureMiniFilmRuntimeDirs(config: MiniFilmConfig) {
    await Promise.all([
      fs.mkdir(this.miniFilmHome(config), { recursive: true }),
      fs.mkdir(this.miniFilmConfigHome(config), { recursive: true }),
      fs.mkdir(this.miniFilmCacheHome(config), { recursive: true }),
      fs.mkdir(this.effectiveHaldDir(config), { recursive: true }),
    ]);
  }

  private miniFilmEnv(config: MiniFilmConfig): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HOME: this.miniFilmHome(config),
      XDG_CONFIG_HOME: this.miniFilmConfigHome(config),
      XDG_CACHE_HOME: this.miniFilmCacheHome(config),
    };
  }

  private miniFilmRuntimeRoot(config: MiniFilmConfig): string {
    return path.join(path.resolve(config.workRoot), 'runtime');
  }

  private miniFilmHome(config: MiniFilmConfig): string {
    return path.join(this.miniFilmRuntimeRoot(config), 'home');
  }

  private miniFilmConfigHome(config: MiniFilmConfig): string {
    return path.join(this.miniFilmRuntimeRoot(config), 'config');
  }

  private miniFilmCacheHome(config: MiniFilmConfig): string {
    return path.join(this.miniFilmRuntimeRoot(config), 'cache');
  }

  private applySkipReason(asset: Asset): string {
    if (asset.type === AssetType.Video || mimeTypes.isVideo(asset.originalPath || asset.originalFileName)) {
      return 'video skipped';
    }
    if (mimeTypes.isImage(asset.originalPath || asset.originalFileName)) {
      return 'apply only supports RAW assets';
    }
    return 'unsupported asset';
  }

  private canSee(auth: AuthDto, ownerId: string): boolean {
    return auth.user.isAdmin || auth.user.id === ownerId;
  }

  private assertCanSee(auth: AuthDto, ownerId: string) {
    if (!this.canSee(auth, ownerId)) {
      throw new ForbiddenException();
    }
  }

  private stopReviewProcess(id: string) {
    const child = this.reviewProcesses.get(id);
    if (!child) {
      return;
    }
    this.reviewProcesses.delete(id);
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  private stopReviewImportProcess(id: string) {
    const child = this.reviewImportProcesses.get(id);
    if (!child) {
      return;
    }
    this.reviewImportProcesses.delete(id);
    if (!child.killed) {
      child.kill('SIGTERM');
    }
  }

  private async appendReviewLog(id: string, text: string) {
    await this.patchReviewSession(id, (session) => ({
      ...session,
      logs: this.limitLog(`${session.logs}${text}`),
      updatedAt: new Date().toISOString(),
    }));
  }

  private async appendApplyLog(id: string, text: string) {
    await this.patchApplyJob(id, (job) => ({
      ...job,
      logs: this.limitLog(`${job.logs}${text}`),
      updatedAt: new Date().toISOString(),
    }));
  }

  private limitLog(log: string): string {
    return log.length > MAX_LOG_LENGTH ? log.slice(-MAX_LOG_LENGTH) : log;
  }

  private async markReviewFailed(id: string, error: Error) {
    void this.stopReviewHistoryWatcher(id);
    void this.stopReviewLiveImportWatcher(id);
    await this.patchReviewSession(
      id,
      (session) => ({
        ...session,
        status: 'failed',
        logs: this.limitLog(`${session.logs}${error.message}\n`),
        progress: this.withProgressStatus(session.progress, 'failed', error.message),
        updatedAt: new Date().toISOString(),
      }),
      { emitProgress: true },
    );
  }

  private async markReviewExited(id: string, code: number | null, signal: NodeJS.Signals | null) {
    this.reviewProcesses.delete(id);
    await this.patchReviewSession(
      id,
      (session) => {
        if (session.status === 'imported' || session.status === 'importing') {
          return { ...session, exitCode: code, signal, updatedAt: new Date().toISOString() };
        }
        void this.stopReviewHistoryWatcher(id);
        void this.stopReviewLiveImportWatcher(id);
        const nextStatus = code === 0 || signal === 'SIGTERM' ? 'stopped' : 'failed';
        return {
          ...session,
          status: nextStatus,
          exitCode: code,
          signal,
          progress: this.withProgressStatus(
            session.progress,
            nextStatus === 'failed' ? 'failed' : 'completed',
            `mini-film review ${nextStatus}`,
          ),
          updatedAt: new Date().toISOString(),
        };
      },
      { emitProgress: true },
    );
  }

  private async findReviewSession(id: string): Promise<StoredReviewSession> {
    const state = await this.getState();
    const session = state.reviewSessions[id];
    if (!session) {
      throw new NotFoundException('mini-film review session not found');
    }
    return session;
  }

  private async findApplyJob(id: string): Promise<StoredApplyJob> {
    const state = await this.getState();
    const job = state.applyJobs[id];
    if (!job) {
      throw new NotFoundException('mini-film apply job not found');
    }
    return job;
  }

  private async patchReviewSession(
    id: string,
    patch: (session: StoredReviewSession) => StoredReviewSession,
    options: { emitProgress?: boolean } = {},
  ): Promise<void> {
    let updated: StoredReviewSession | undefined;
    await this.updateState((state) => {
      const session = state.reviewSessions[id];
      if (session) {
        updated = patch(session);
        state.reviewSessions[id] = updated;
      }
    });
    if (options.emitProgress && updated) {
      this.emitMiniFilmProgress('review', updated);
    }
  }

  private async patchApplyJob(
    id: string,
    patch: (job: StoredApplyJob) => StoredApplyJob,
    options: { emitProgress?: boolean } = {},
  ): Promise<void> {
    let updated: StoredApplyJob | undefined;
    await this.updateState((state) => {
      const job = state.applyJobs[id];
      if (job) {
        updated = patch(job);
        state.applyJobs[id] = updated;
      }
    });
    if (options.emitProgress && updated) {
      this.emitMiniFilmProgress('apply', updated);
    }
  }

  private async getState(): Promise<MiniFilmState> {
    const state = (await this.systemMetadataRepository.get(SystemMetadataKey.MiniFilmState)) as MiniFilmState | null;
    return {
      reviewSessions: state?.reviewSessions
        ? Object.fromEntries(
            Object.entries(state.reviewSessions).map(([id, session]) => [id, this.normalizeReviewSession(session)]),
          )
        : {},
      applyJobs: state?.applyJobs
        ? Object.fromEntries(Object.entries(state.applyJobs).map(([id, job]) => [id, this.normalizeApplyJob(job)]))
        : {},
    };
  }

  private normalizeReviewSession(session: StoredReviewSession): StoredReviewSession {
    const updatedAt = session.updatedAt ?? session.createdAt ?? new Date().toISOString();
    return {
      ...session,
      historyPath: session.historyPath ?? path.join(session.outputDir, 'history.txt'),
      progress: session.progress ?? {
        stage:
          session.status === 'failed'
            ? 'failed'
            : session.status === 'imported'
              ? 'completed'
              : session.status === 'importing'
                ? 'importing'
                : 'discovering',
        processed: session.importedAssetIds?.length ?? 0,
        total: session.assetIds?.length ?? 0,
        percent: this.progressPercent(session.importedAssetIds?.length ?? 0, session.assetIds?.length ?? 0),
        message:
          session.status === 'imported' ? 'mini-film review imported into Immich' : 'Waiting for mini-film history',
        updatedAt,
        imported: session.importedAssetIds?.length ?? 0,
        skipped: session.skippedAssets?.length ?? 0,
      },
    };
  }

  private normalizeApplyJob(job: StoredApplyJob): StoredApplyJob {
    const updatedAt = job.updatedAt ?? job.createdAt ?? new Date().toISOString();
    return {
      ...job,
      progress: job.progress ?? {
        stage: job.status === 'failed' ? 'failed' : job.status === 'completed' ? 'completed' : 'rendering',
        processed: job.processed ?? 0,
        total: job.total ?? 0,
        percent: this.progressPercent(job.processed ?? 0, job.total ?? 0),
        message: job.status === 'completed' ? 'mini-film apply completed' : 'mini-film apply queued',
        updatedAt,
        imported: job.importedAssetIds?.length ?? 0,
        skipped: job.skippedAssets?.length ?? 0,
      },
    };
  }

  private async updateState(mutator: (state: MiniFilmState) => void): Promise<void> {
    const state = await this.getState();
    mutator(state);
    await this.systemMetadataRepository.set(SystemMetadataKey.MiniFilmState, state as any);
  }

  private async isDirectory(value: string): Promise<boolean> {
    return fs
      .stat(value)
      .then((stat) => stat.isDirectory())
      .catch(() => false);
  }

  private async fileExists(value: string): Promise<boolean> {
    return fs
      .stat(value)
      .then((stat) => stat.isFile())
      .catch(() => false);
  }

  private async isStableImportFile(
    value: string,
    seenFiles?: Map<string, { size: number; mtimeMs: number }>,
  ): Promise<boolean> {
    const first = await fs.stat(value).catch(() => null);
    if (!first?.isFile() || first.size <= 0) {
      return false;
    }

    if (seenFiles) {
      const current = { size: first.size, mtimeMs: first.mtimeMs };
      const previous = seenFiles.get(value);
      seenFiles.set(value, current);
      return Boolean(
        previous &&
        previous.size === current.size &&
        previous.mtimeMs === current.mtimeMs &&
        Date.now() - current.mtimeMs >= IMPORT_STABLE_DELAY_MS,
      );
    }

    await this.sleep(IMPORT_STABLE_DELAY_MS);
    const second = await fs.stat(value).catch(() => null);
    return Boolean(
      second?.isFile() &&
      second.size === first.size &&
      second.mtimeMs === first.mtimeMs &&
      Date.now() - second.mtimeMs >= IMPORT_STABLE_DELAY_MS,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
