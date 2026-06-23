import { BadRequestException, Injectable } from '@nestjs/common';
import { Insertable } from 'kysely';
import { R_OK } from 'node:constants';
import { randomUUID } from 'node:crypto';
import { Stats } from 'node:fs';
import path, { isAbsolute, parse } from 'node:path';
import picomatch from 'picomatch';
import { JOBS_LIBRARY_PAGINATION_SIZE } from 'src/constants';
import { StorageCore } from 'src/cores/storage.core';
import { OnEvent, OnJob } from 'src/decorators';
import {
  CreateLibraryDto,
  LibraryResponseDto,
  LibraryStatsResponseDto,
  mapLibrary,
  UpdateLibraryDto,
  ValidateLibraryDto,
  ValidateLibraryImportPathResponseDto,
  ValidateLibraryResponseDto,
} from 'src/dtos/library.dto';
import {
  AssetStatus,
  AssetType,
  ChecksumAlgorithm,
  CronJob,
  DatabaseLock,
  ImmichWorker,
  JobName,
  JobStatus,
  QueueName,
} from 'src/enum';
import { ArgOf, ArgsOf } from 'src/repositories/event.repository';
import { AssetSyncResult } from 'src/repositories/library.repository';
import { AssetTable } from 'src/schema/tables/asset.table';
import { BaseService } from 'src/services/base.service';
import { JobOf } from 'src/types';
import { mimeTypes } from 'src/utils/mime-types';
import { handlePromiseError } from 'src/utils/misc';

type LibraryScanRunState = {
  healthCheckUrl: string;
  pendingJobs: number;
  hasFailure: boolean;
};

@Injectable()
export class LibraryService extends BaseService {
  private watchLibraries = false;
  private lock = false;
  private watchers: Record<string, () => Promise<void>> = {};
  private libraryScanRuns = new Map<string, LibraryScanRunState>();

  private createLibraryScanRunId() {
    const runId = randomUUID();
    this.logger.debug(`Created library scan runId ${runId}`);
    return { runId };
  }

  private getLibraryScanRunId(job: { data?: unknown }) {
    if (!job.data || typeof job.data !== 'object') {
      this.logger.debug('Library scan event received without job data; unable to extract runId');
      return;
    }

    const runId = (job.data as { runId?: unknown }).runId;

    if (typeof runId === 'string') {
      return runId;
    }

    this.logger.debug(`Library scan event has non-string runId payload ${JSON.stringify(runId)}`);
    return undefined;
  }

  private async ensureLibraryScanRunStarted(runId: string | undefined) {
    if (!runId) {
      this.logger.debug('Library scan runId missing during start; skipping healthcheck tracking');
      return;
    }

    if (this.libraryScanRuns.has(runId)) {
      return;
    }

    const {
      library: {
        scan: { healthCheckUrl },
      },
    } = await this.getConfig({ withCache: true });
    const trimmedUrl = healthCheckUrl?.trim();

    if (!trimmedUrl) {
      this.logger.debug(`Library scan run ${runId} has no configured healthCheckUrl; skipping healthchecks`);
      return;
    }

    this.logger.debug(`Starting library scan run ${runId} with healthCheckUrl ${trimmedUrl}`);

    this.libraryScanRuns.set(runId, {
      hasFailure: false,
      healthCheckUrl: trimmedUrl,
      pendingJobs: 0,
    });

    this.logger.log(`Sending library scan start healthcheck for run ${runId}`);
    await this.sendLibraryScanHealthCheck(trimmedUrl, 'start', runId);
  }

  private startLibraryScanJob(runId: string | undefined) {
    const state = this.getLibraryScanRun(runId);
    if (!state) {
      this.logger.debug(`No tracked library scan state for run ${runId}; skipping start counter`);
      return;
    }

    state.pendingJobs += 1;
    this.logger.debug(`Library scan job started for run ${runId}; pendingJobs=${state.pendingJobs}`);
  }

  private async completeLibraryScanJob(runId: string | undefined, failed = false) {
    if (!runId) {
      this.logger.debug('Library scan completion event missing runId; skipping counter decrement');
      return;
    }

    const state = this.getLibraryScanRun(runId);
    if (!state) {
      this.logger.debug(`No tracked library scan state for run ${runId}; skipping completion`);
      return;
    }

    if (failed) {
      state.hasFailure = true;
    }

    state.pendingJobs -= 1;
    this.logger.debug(`Library scan job completed for run ${runId}; pendingJobs=${state.pendingJobs} failed=${failed}`);

    if (state.pendingJobs > 0) {
      return;
    }

    if (state.pendingJobs < 0) {
      this.logger.warn(`Library scan health check run ${runId} has negative pendingJobs; normalizing`);
      this.libraryScanRuns.delete(runId);
      return;
    }

    this.libraryScanRuns.delete(runId);
    this.logger.log(`Library scan run ${runId} completed; sending ${state.hasFailure ? 'fail' : 'ping'} healthcheck`);

    await this.sendLibraryScanHealthCheck(state.healthCheckUrl, state.hasFailure ? 'fail' : 'ping', runId);
  }

  private isTrackingLibraryScanJob(jobName: JobName) {
    return (
      jobName === JobName.LibraryScanQueueAll ||
      jobName === JobName.LibraryDeleteCheck ||
      jobName === JobName.LibrarySyncFilesQueueAll ||
      jobName === JobName.LibrarySyncAssetsQueueAll ||
      jobName === JobName.LibrarySyncFiles ||
      jobName === JobName.LibrarySyncAssets ||
      jobName === JobName.LibraryDelete
    );
  }

  private getLibraryScanRun(runId: string | undefined) {
    if (!runId) {
      return;
    }

    return this.libraryScanRuns.get(runId);
  }

  private async sendLibraryScanHealthCheck(url: string, type: 'start' | 'ping' | 'fail', runId: string) {
    const endpointWithRunId = this.getLibraryScanHealthCheckEndpoint(url, type, runId);
    const endpointWithoutRunId = this.getLibraryScanHealthCheckEndpoint(url, type);
    const endpoints = [endpointWithRunId];
    this.logger.debug(`Sending library scan healthcheck type=${type} runId=${runId} baseUrl=${url}`);

    if (endpointWithoutRunId !== endpointWithRunId) {
      endpoints.push(endpointWithoutRunId);
    }

    try {
      for (const endpoint of endpoints) {
        this.logger.debug(`Trying healthcheck endpoint ${endpoint}`);
        const response = await fetch(endpoint, {
          method: 'POST',
          signal: AbortSignal.timeout(15000),
        });
        const responseText = await response.text();

        if (response.ok) {
          this.logger.log(`Healthcheck ${type} accepted for run ${runId} at ${endpoint}`);
          return;
        }

        if (
          endpoint === endpointWithRunId &&
          response.status === 400 &&
          responseText.toLowerCase().includes('invalid uuid')
        ) {
          this.logger.debug(`Healthcheck ${type} run ${runId} rejected due invalid uuid; retrying without rid`);
          continue;
        }

        this.logger.warn(
          `Failed to send library scan health check "${type}" to "${endpoint}" (${response.status}): ${response.statusText} / ${responseText}`,
        );
        return;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : `${error}`;
      this.logger.warn(`Failed to send library scan health check "${type}" to "${url}": ${errorMessage}`);
    }
  }

  private getLibraryScanHealthCheckEndpoint(url: string, type: 'start' | 'ping' | 'fail', runId?: string) {
    const trimmedUrl = url.endsWith('/') ? url.slice(0, -1) : url;

    let endpoint = trimmedUrl;
    if (type === 'start') {
      endpoint = `${trimmedUrl}/start`;
    }

    if (type === 'fail') {
      endpoint = `${trimmedUrl}/fail`;
    }

    if (type === 'ping') {
      endpoint = trimmedUrl;
    }

    if (!runId) {
      return endpoint;
    }

    const separator = endpoint.includes('?') ? '&' : '?';
    return `${endpoint}${separator}rid=${runId}`;
  }

  @OnEvent({ name: 'JobStart', workers: [ImmichWorker.Microservices] })
  async onLibraryScanJobStart(...[, job]: ArgsOf<'JobStart'>) {
    if (!this.isTrackingLibraryScanJob(job.name)) {
      return;
    }

    const runId = this.getLibraryScanRunId(job);
    this.logger.debug(`JobStart for library scan job ${job.name} runId=${runId}`);
    await this.ensureLibraryScanRunStarted(runId);
    this.startLibraryScanJob(runId);
  }

  @OnEvent({ name: 'JobSuccess', workers: [ImmichWorker.Microservices] })
  async onLibraryScanJobSuccess({ job }: ArgOf<'JobSuccess'>) {
    if (!this.isTrackingLibraryScanJob(job.name)) {
      return;
    }

    const runId = this.getLibraryScanRunId(job);
    this.logger.debug(`JobSuccess for library scan job ${job.name} runId=${runId}`);
    await this.completeLibraryScanJob(runId);
  }

  @OnEvent({ name: 'JobError', workers: [ImmichWorker.Microservices] })
  async onLibraryScanJobError({ job }: ArgOf<'JobError'>) {
    if (!this.isTrackingLibraryScanJob(job.name)) {
      return;
    }

    const runId = this.getLibraryScanRunId(job);
    this.logger.debug(`JobError for library scan job ${job.name} runId=${runId}`);
    await this.completeLibraryScanJob(runId, true);
  }

  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit({
    newConfig: {
      library: { watch, scan },
    },
  }: ArgOf<'ConfigInit'>) {
    // This ensures that library watching only occurs in one microservice
    this.lock = await this.databaseRepository.tryLock(DatabaseLock.Library);

    this.watchLibraries = this.lock && watch.enabled;

    if (this.lock) {
      this.logger.debug(`Library cron enabled=${scan.enabled}; expression=${scan.cronExpression}`);
      this.cronRepository.create({
        name: CronJob.LibraryScan,
        expression: scan.cronExpression,
        onTick: () =>
          handlePromiseError(
            this.jobRepository.queue({
              name: JobName.LibraryScanQueueAll,
              data: this.createLibraryScanRunId(),
            }),
            this.logger,
          ),
        start: scan.enabled,
      });
    }

    const trimmedHealthCheckUrl = scan.healthCheckUrl?.trim();
    if (trimmedHealthCheckUrl) {
      this.logger.log(`Library scan health check URL configured: ${trimmedHealthCheckUrl}`);
    } else {
      this.logger.debug('Library scan health check URL is not configured.');
    }

    if (this.watchLibraries) {
      await this.watchAll();
    }
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  async onConfigUpdate({ newConfig: { library } }: ArgOf<'ConfigUpdate'>) {
    if (!this.lock) {
      return;
    }

    this.cronRepository.update({
      name: CronJob.LibraryScan,
      expression: library.scan.cronExpression,
      start: library.scan.enabled,
    });

    if (library.watch.enabled !== this.watchLibraries) {
      // Watch configuration changed, update accordingly
      this.watchLibraries = library.watch.enabled;
      await (this.watchLibraries ? this.watchAll() : this.unwatchAll());
    }
  }

  private async watch(id: string): Promise<boolean> {
    if (!this.watchLibraries) {
      return false;
    }

    const library = await this.findOrFail(id);
    if (library.importPaths.length === 0) {
      return false;
    }

    await this.unwatch(id);

    this.logger.log(`Starting to watch library ${library.id} with import path(s) ${library.importPaths}`);

    const matcher = picomatch(`**/*{${mimeTypes.getSupportedFileExtensions().join(',')}}`, {
      nocase: true,
      ignore: library.exclusionPatterns,
    });

    let _resolve: () => void;
    const ready$ = new Promise<void>((resolve) => (_resolve = resolve));

    const handler = async (event: string, path: string) => {
      if (matcher(path)) {
        this.logger.debug(`File ${event} event received for ${path} in library ${library.id}}`);
        await this.jobRepository.queue({
          name: JobName.LibrarySyncFiles,
          data: { libraryId: library.id, paths: [path] },
        });
      } else {
        this.logger.verbose(`Ignoring file ${event} event for ${path} in library ${library.id}`);
      }
    };

    const deletionHandler = async (path: string) => {
      this.logger.debug(`File unlink event received for ${path} in library ${library.id}}`);
      await this.jobRepository.queue({
        name: JobName.LibraryRemoveAsset,
        data: { libraryId: library.id, paths: [path] },
      });
    };

    this.watchers[id] = this.storageRepository.watch(
      library.importPaths,
      {
        usePolling: false,
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 5000,
          pollInterval: 1000,
        },
      },
      {
        onReady: () => _resolve(),
        onAdd: (path) => {
          return handlePromiseError(handler('add', path), this.logger);
        },
        onChange: (path) => {
          return handlePromiseError(handler('change', path), this.logger);
        },
        onUnlink: (path) => {
          return handlePromiseError(deletionHandler(path), this.logger);
        },
        onError: (error) => {
          this.logger.error(`Library watcher for library ${library.id} encountered error: ${error}`);
        },
      },
    );

    // Wait for the watcher to initialize before returning
    await ready$;

    return true;
  }

  async unwatch(id: string) {
    if (this.watchers[id]) {
      await this.watchers[id]();
      delete this.watchers[id];
    }
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    await this.unwatchAll();
  }

  private async unwatchAll() {
    if (!this.lock) {
      return false;
    }

    for (const id in this.watchers) {
      await this.unwatch(id);
    }
  }

  async watchAll() {
    if (!this.lock) {
      return false;
    }

    const libraries = await this.libraryRepository.getAll(false);
    for (const library of libraries) {
      await this.watch(library.id);
    }
  }

  async getStatistics(id: string): Promise<LibraryStatsResponseDto> {
    const statistics = await this.libraryRepository.getStatistics(id);
    if (!statistics) {
      throw new BadRequestException(`Library ${id} not found`);
    }
    return statistics;
  }

  async get(id: string): Promise<LibraryResponseDto> {
    const library = await this.findOrFail(id);
    return mapLibrary(library);
  }

  async getAll(): Promise<LibraryResponseDto[]> {
    const libraries = await this.libraryRepository.getAll(false);
    return libraries.map((library) => mapLibrary(library));
  }

  @OnJob({ name: JobName.LibraryDeleteCheck, queue: QueueName.Library })
  async handleQueueCleanup(job: JobOf<JobName.LibraryDeleteCheck>): Promise<JobStatus> {
    this.logger.log('Checking for any libraries pending deletion...');
    const pendingDeletions = await this.libraryRepository.getAllDeleted();
    if (pendingDeletions.length > 0) {
      const libraryString = pendingDeletions.length === 1 ? 'library' : 'libraries';
      this.logger.log(`Found ${pendingDeletions.length} ${libraryString} pending deletion, cleaning up...`);

      await this.jobRepository.queueAll(
        pendingDeletions.map((libraryToDelete) => ({
          name: JobName.LibraryDelete,
          data: { id: libraryToDelete.id, runId: job.runId },
        })),
      );
    }

    return JobStatus.Success;
  }

  async create(dto: CreateLibraryDto): Promise<LibraryResponseDto> {
    const library = await this.libraryRepository.create({
      ownerId: dto.ownerId,
      name: dto.name ?? 'New External Library',
      importPaths: dto.importPaths ?? [],
      exclusionPatterns: dto.exclusionPatterns ?? [
        '**/@eaDir/**',
        '**/._*',
        '**/#recycle/**',
        '**/#snapshot/**',
        '**/.stversions/**',
        '**/.stfolder/**',
      ],
    });
    return mapLibrary(library);
  }

  @OnJob({ name: JobName.LibrarySyncFiles, queue: QueueName.Library })
  async handleSyncFiles(job: JobOf<JobName.LibrarySyncFiles>): Promise<JobStatus> {
    const library = await this.libraryRepository.get(job.libraryId);
    // We need to check if the library still exists as it could have been deleted after the scan was queued
    if (!library) {
      this.logger.debug(`Library ${job.libraryId} not found, skipping file import`);
      return JobStatus.Failed;
    } else if (library.deletedAt) {
      this.logger.debug(`Library ${job.libraryId} is deleted, won't import assets into it`);
      return JobStatus.Failed;
    }

    const assetImports: Insertable<AssetTable>[] = [];
    await Promise.all(
      job.paths.map((path) =>
        this.processEntity(path, library.ownerId, job.libraryId)
          .then((asset) => assetImports.push(asset))
          .catch((error: any) => this.logger.error(`Error processing ${path} for library ${job.libraryId}: ${error}`)),
      ),
    );

    const assetIds = await this.assetRepository.createAll(assetImports);

    const progressMessage =
      job.progressCounter && job.totalAssets
        ? `(${job.progressCounter} of ${job.totalAssets})`
        : `(${job.progressCounter} done so far)`;

    this.logger.log(`Imported ${assetIds.length} ${progressMessage} file(s) into library ${job.libraryId}`);

    await this.queuePostSyncJobs(assetIds);

    return JobStatus.Success;
  }

  private async validateImportPath(importPath: string): Promise<ValidateLibraryImportPathResponseDto> {
    const validation = new ValidateLibraryImportPathResponseDto();
    validation.importPath = importPath;
    validation.isValid = false;

    if (StorageCore.isImmichPath(importPath)) {
      validation.message = 'Cannot use media upload folder for external libraries';
      return validation;
    }

    if (!isAbsolute(importPath)) {
      validation.message = `Import path must be absolute, try ${path.resolve(importPath)}`;
      return validation;
    }

    try {
      const stat = await this.storageRepository.stat(importPath);
      if (!stat.isDirectory()) {
        validation.message = 'Not a directory';
        return validation;
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        validation.message = 'Path does not exist (ENOENT)';
        return validation;
      }
      validation.message = String(error);
      return validation;
    }

    const access = await this.storageRepository.checkFileExists(importPath, R_OK);

    if (!access) {
      validation.message = 'Lacking read permission for folder';
      return validation;
    }

    validation.isValid = true;
    return validation;
  }

  async validate(id: string, dto: ValidateLibraryDto): Promise<ValidateLibraryResponseDto> {
    const importPaths = await Promise.all(
      (dto.importPaths || []).map((importPath) => this.validateImportPath(importPath)),
    );
    return { importPaths };
  }

  async update(id: string, dto: UpdateLibraryDto): Promise<LibraryResponseDto> {
    await this.findOrFail(id);

    if (dto.importPaths) {
      const validation = await this.validate(id, { importPaths: dto.importPaths });
      if (validation.importPaths) {
        for (const path of validation.importPaths) {
          if (!path.isValid) {
            throw new BadRequestException(`Invalid import path: ${path.message}`);
          }
        }
      }
    }

    const library = await this.libraryRepository.update(id, dto);
    return mapLibrary(library);
  }

  async delete(id: string) {
    await this.findOrFail(id);

    if (this.watchLibraries) {
      await this.unwatch(id);
    }

    await this.libraryRepository.softDelete(id);
    await this.jobRepository.queue({ name: JobName.LibraryDelete, data: { id } });
  }

  @OnJob({ name: JobName.LibraryDelete, queue: QueueName.Library })
  async handleDeleteLibrary(job: JobOf<JobName.LibraryDelete>): Promise<JobStatus> {
    const libraryId = job.id;

    await this.assetRepository.updateByLibraryId(libraryId, { deletedAt: new Date() });

    let assetsFound = false;
    let chunk: string[] = [];

    const queueChunk = async () => {
      if (chunk.length > 0) {
        assetsFound = true;
        this.logger.debug(`Queueing deletion of ${chunk.length} asset(s) in library ${libraryId}`);
        await this.jobRepository.queueAll(
          chunk.map((id) => ({ name: JobName.AssetDelete, data: { id, deleteOnDisk: false } })),
        );
        chunk = [];
      }
    };

    this.logger.debug(`Will delete all assets in library ${libraryId}`);
    const assets = this.libraryRepository.streamAssetIds(libraryId);
    for await (const asset of assets) {
      chunk.push(asset.id);

      if (chunk.length >= JOBS_LIBRARY_PAGINATION_SIZE) {
        await queueChunk();
      }
    }

    await queueChunk();

    if (!assetsFound) {
      this.logger.log(`Deleting library ${libraryId}`);
      await this.libraryRepository.delete(libraryId);
    }

    return JobStatus.Success;
  }

  private async processEntity(filePath: string, ownerId: string, libraryId: string) {
    const assetPath = path.normalize(filePath);
    const stat = await this.storageRepository.stat(assetPath);

    return {
      ownerId,
      libraryId,
      checksum: this.cryptoRepository.hashSha1(`path:${assetPath}`),
      checksumAlgorithm: ChecksumAlgorithm.sha1Path,
      originalPath: assetPath,

      fileCreatedAt: stat.mtime,
      fileModifiedAt: stat.mtime,
      localDateTime: stat.mtime,
      type: mimeTypes.isVideo(assetPath) ? AssetType.Video : AssetType.Image,
      originalFileName: parse(assetPath).base,
      isExternal: true,
      livePhotoVideoId: null,
    };
  }

  async queuePostSyncJobs(assetIds: string[]) {
    this.logger.debug(`Queuing sidecar discovery for ${assetIds.length} asset(s)`);

    // We queue a sidecar discovery which, in turn, queues metadata extraction
    await this.jobRepository.queueAll(
      assetIds.map((assetId) => ({
        name: JobName.SidecarCheck,
        data: { id: assetId, source: 'upload' },
      })),
    );
  }

  async queueScan(id: string) {
    await this.findOrFail(id);

    const { runId } = this.createLibraryScanRunId();
    this.logger.log(`Starting to scan library ${id}`);

    await this.jobRepository.queue({
      name: JobName.LibrarySyncFilesQueueAll,
      data: {
        id,
        runId,
      },
    });

    await this.jobRepository.queue({ name: JobName.LibrarySyncAssetsQueueAll, data: { id, runId } });
  }

  async queueScanAll() {
    const { runId } = this.createLibraryScanRunId();
    await this.jobRepository.queue({ name: JobName.LibraryScanQueueAll, data: { runId } });
  }

  @OnJob({ name: JobName.LibraryScanQueueAll, queue: QueueName.Library })
  async handleQueueScanAll(job: JobOf<JobName.LibraryScanQueueAll>): Promise<JobStatus> {
    const runId = job?.runId;
    this.logger.log(`Initiating scan of all external libraries...`);

    await this.jobRepository.queue({ name: JobName.LibraryDeleteCheck, data: { runId } });

    const libraries = await this.libraryRepository.getAll(true);

    await this.jobRepository.queueAll(
      libraries.map((library) => ({
        name: JobName.LibrarySyncFilesQueueAll,
        data: {
          id: library.id,
          runId,
        },
      })),
    );

    await this.jobRepository.queueAll(
      libraries.map((library) => ({
        name: JobName.LibrarySyncAssetsQueueAll,
        data: {
          id: library.id,
          runId,
        },
      })),
    );

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.LibrarySyncAssets, queue: QueueName.Library })
  async handleSyncAssets(job: JobOf<JobName.LibrarySyncAssets>): Promise<JobStatus> {
    const assets = await this.assetJobRepository.getForSyncAssets(job.assetIds);

    const assetIdsToOffline: string[] = [];
    const trashedAssetIdsToOffline: string[] = [];
    const assetIdsToOnline: string[] = [];
    const trashedAssetIdsToOnline: string[] = [];
    const assetIdsToUpdate: string[] = [];

    this.logger.debug(`Checking batch of ${assets.length} existing asset(s) in library ${job.libraryId}`);

    const stats = await Promise.all(
      assets.map((asset) => this.storageRepository.stat(asset.originalPath).catch(() => null)),
    );

    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      const stat = stats[i];
      const action = this.checkExistingAsset(asset, stat);
      switch (action) {
        case AssetSyncResult.DO_NOTHING: {
          break;
        }
        case AssetSyncResult.OFFLINE: {
          if (asset.status === AssetStatus.Trashed) {
            trashedAssetIdsToOffline.push(asset.id);
          } else {
            assetIdsToOffline.push(asset.id);
          }
          break;
        }
        case AssetSyncResult.UPDATE: {
          assetIdsToUpdate.push(asset.id);
          break;
        }
        case AssetSyncResult.CHECK_OFFLINE: {
          const isInImportPath = job.importPaths.find((path) => asset.originalPath.startsWith(path));

          if (!isInImportPath) {
            this.logger.verbose(
              `Offline asset ${asset.originalPath} is still not in any import path, keeping offline in library ${job.libraryId}`,
            );
            break;
          }

          const isExcluded = job.exclusionPatterns.some((pattern) => picomatch.isMatch(asset.originalPath, pattern));

          if (!isExcluded) {
            this.logger.debug(`Offline asset ${asset.originalPath} is now online in library ${job.libraryId}`);
            if (asset.status === AssetStatus.Trashed) {
              trashedAssetIdsToOnline.push(asset.id);
            } else {
              assetIdsToOnline.push(asset.id);
            }
            break;
          }

          this.logger.verbose(
            `Offline asset ${asset.originalPath} is in an import path but still covered by exclusion pattern, keeping offline in library ${job.libraryId}`,
          );

          break;
        }
      }
    }

    const promises = [];
    if (assetIdsToOffline.length > 0) {
      promises.push(this.assetRepository.updateAll(assetIdsToOffline, { isOffline: true, deletedAt: new Date() }));
    }

    if (trashedAssetIdsToOffline.length > 0) {
      promises.push(this.assetRepository.updateAll(trashedAssetIdsToOffline, { isOffline: true }));
    }

    if (assetIdsToOnline.length > 0) {
      promises.push(this.assetRepository.updateAll(assetIdsToOnline, { isOffline: false, deletedAt: null }));
    }

    if (trashedAssetIdsToOnline.length > 0) {
      promises.push(this.assetRepository.updateAll(trashedAssetIdsToOnline, { isOffline: false }));
    }

    if (assetIdsToUpdate.length > 0) {
      promises.push(this.queuePostSyncJobs(assetIdsToUpdate));
    }

    await Promise.all(promises);

    const remainingCount = assets.length - assetIdsToOffline.length - assetIdsToUpdate.length - assetIdsToOnline.length;
    const cumulativePercentage = ((100 * job.progressCounter) / job.totalAssets).toFixed(1);
    this.logger.log(
      `Checked existing asset(s): ${assetIdsToOffline.length + trashedAssetIdsToOffline.length} offlined, ${assetIdsToOnline.length + trashedAssetIdsToOnline.length} onlined, ${assetIdsToUpdate.length} updated, ${remainingCount} unchanged of current batch of ${assets.length} (Total progress: ${job.progressCounter} of ${job.totalAssets}, ${cumulativePercentage} %) in library ${job.libraryId}.`,
    );

    return JobStatus.Success;
  }

  private checkExistingAsset(
    asset: {
      isOffline: boolean;
      libraryId: string | null;
      originalPath: string;
      status: AssetStatus;
      fileModifiedAt: Date;
    },
    stat: Stats | null,
  ): AssetSyncResult {
    if (!stat) {
      // File not found on disk or permission error
      if (asset.isOffline) {
        this.logger.verbose(
          `Asset ${asset.originalPath} is still not accessible, keeping offline in library ${asset.libraryId}`,
        );
        return AssetSyncResult.DO_NOTHING;
      }

      this.logger.debug(
        `Asset ${asset.originalPath} is no longer on disk or is inaccessible because of permissions, marking offline in library ${asset.libraryId}`,
      );
      return AssetSyncResult.OFFLINE;
    }

    if (asset.isOffline && asset.status !== AssetStatus.Deleted) {
      // Only perform the expensive check if the asset is offline
      return AssetSyncResult.CHECK_OFFLINE;
    }

    if (stat.mtime.valueOf() !== asset.fileModifiedAt.valueOf()) {
      this.logger.verbose(`Asset ${asset.originalPath} needs metadata extraction in library ${asset.libraryId}`);

      return AssetSyncResult.UPDATE;
    }

    return AssetSyncResult.DO_NOTHING;
  }

  @OnJob({ name: JobName.LibrarySyncFilesQueueAll, queue: QueueName.Library })
  async handleQueueSyncFiles(job: JobOf<JobName.LibrarySyncFilesQueueAll>): Promise<JobStatus> {
    const library = await this.libraryRepository.get(job.id);
    if (!library) {
      this.logger.debug(`Library ${job.id} not found, skipping refresh`);
      return JobStatus.Skipped;
    }

    this.logger.debug(`Validating import paths for library ${library.id}...`);

    const validImportPaths: string[] = [];

    for (const importPath of library.importPaths) {
      const validation = await this.validateImportPath(importPath);
      if (validation.isValid) {
        validImportPaths.push(path.normalize(importPath));
      } else {
        this.logger.warn(`Skipping invalid import path: ${importPath}. Reason: ${validation.message}`);
      }
    }

    if (validImportPaths.length === 0) {
      this.logger.warn(`No valid import paths found for library ${library.id}`);

      return JobStatus.Skipped;
    }

    const pathsOnDisk = this.storageRepository.walk({
      pathsToCrawl: validImportPaths,
      includeHidden: false,
      exclusionPatterns: library.exclusionPatterns,
      take: JOBS_LIBRARY_PAGINATION_SIZE,
    });

    let importCount = 0;
    let crawlCount = 0;

    this.logger.log(`Starting disk crawl of ${validImportPaths.length} import path(s) for library ${library.id}...`);

    for await (const pathBatch of pathsOnDisk) {
      crawlCount += pathBatch.length;
      const paths = await this.assetRepository.filterNewExternalAssetPaths(library.id, pathBatch);

      if (paths.length > 0) {
        importCount += paths.length;

        await this.jobRepository.queue({
          name: JobName.LibrarySyncFiles,
          data: {
            libraryId: library.id,
            paths,
            progressCounter: crawlCount,
            runId: job.runId,
          },
        });
      }

      this.logger.log(
        `Crawled ${crawlCount} file(s) so far: ${paths.length} of current batch of ${pathBatch.length} will be imported to library ${library.id}...`,
      );
    }

    this.logger.log(
      `Finished disk crawl, ${crawlCount} file(s) found on disk and queued ${importCount} file(s) for import into ${library.id}`,
    );

    await this.libraryRepository.update(job.id, { refreshedAt: new Date() });

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.LibraryRemoveAsset, queue: QueueName.Library })
  async handleAssetRemoval(job: JobOf<JobName.LibraryRemoveAsset>): Promise<JobStatus> {
    // This is only for handling file unlink events via the file watcher
    this.logger.verbose(`Deleting asset(s) ${job.paths} from library ${job.libraryId}`);
    for (const assetPath of job.paths) {
      const asset = await this.assetRepository.getByLibraryIdAndOriginalPath(job.libraryId, assetPath);
      if (asset) {
        await this.assetRepository.remove(asset);
      }
    }

    return JobStatus.Success;
  }

  @OnJob({ name: JobName.LibrarySyncAssetsQueueAll, queue: QueueName.Library })
  async handleQueueSyncAssets(job: JobOf<JobName.LibrarySyncAssetsQueueAll>): Promise<JobStatus> {
    const library = await this.libraryRepository.get(job.id);
    if (!library) {
      return JobStatus.Skipped;
    }

    const assetCount = await this.assetRepository.getLibraryAssetCount(job.id);
    if (!assetCount) {
      this.logger.log(`Library ${library.id} is empty, no need to check assets`);
      return JobStatus.Success;
    }

    this.logger.log(
      `Checking ${assetCount} asset(s) against import paths and exclusion patterns in library ${library.id}...`,
    );

    const offlineResult = await this.assetRepository.detectOfflineExternalAssets(
      library.id,
      library.importPaths,
      library.exclusionPatterns,
    );

    const affectedAssetCount = Number(offlineResult.numUpdatedRows);

    this.logger.log(
      `${affectedAssetCount} asset(s) out of ${assetCount} were offlined due to import paths and/or exclusion pattern(s) in library ${library.id}`,
    );

    if (affectedAssetCount === assetCount) {
      return JobStatus.Success;
    }

    let chunk: string[] = [];
    let count = 0;

    const queueChunk = async () => {
      if (chunk.length > 0) {
        count += chunk.length;

        await this.jobRepository.queue({
          name: JobName.LibrarySyncAssets,
          data: {
            libraryId: library.id,
            importPaths: library.importPaths,
            exclusionPatterns: library.exclusionPatterns,
            assetIds: chunk.map((id) => id),
            progressCounter: count,
            totalAssets: assetCount,
            runId: job.runId,
          },
        });
        chunk = [];

        const completePercentage = ((100 * count) / assetCount).toFixed(1);

        this.logger.log(
          `Queued check of ${count} of ${assetCount} (${completePercentage} %) existing asset(s) so far in library ${library.id}`,
        );
      }
    };

    this.logger.log(`Scanning library ${library.id} for assets missing from disk...`);
    const existingAssets = this.libraryRepository.streamAssetIds(library.id);

    for await (const asset of existingAssets) {
      chunk.push(asset.id);
      if (chunk.length === JOBS_LIBRARY_PAGINATION_SIZE) {
        await queueChunk();
      }
    }

    await queueChunk();

    this.logger.log(`Finished queuing ${count} asset check(s) for library ${library.id}`);

    return JobStatus.Success;
  }

  private async findOrFail(id: string) {
    const library = await this.libraryRepository.get(id);
    if (!library) {
      throw new BadRequestException('Library not found');
    }
    return library;
  }
}
