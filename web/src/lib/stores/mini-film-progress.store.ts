import { writable } from 'svelte/store';
import {
  listMiniFilmApplyJobs,
  listMiniFilmReviewSessions,
  type MiniFilmApplyJob,
  type MiniFilmProgressEvent,
  type MiniFilmReviewSession,
} from '$lib/services/mini-film.service';
import { websocketEvents } from '$lib/stores/websocket';

export type MiniFilmActivityItem =
  | { mode: 'apply'; id: string; job: MiniFilmApplyJob; updatedAt: string }
  | { mode: 'review'; id: string; session: MiniFilmReviewSession; updatedAt: string };

type MiniFilmProgressState = {
  loading: boolean;
  error?: string;
  items: MiniFilmActivityItem[];
};

const terminalApplyStatuses = new Set<MiniFilmApplyJob['status']>(['completed', 'failed']);
const terminalReviewStatuses = new Set<MiniFilmReviewSession['status']>(['stopped', 'failed', 'imported']);

const createMiniFilmProgressStore = () => {
  const { subscribe, update, set } = writable<MiniFilmProgressState>({ loading: false, items: [] });
  let websocketCleanup: (() => void) | undefined;

  const sortItems = (items: MiniFilmActivityItem[]) =>
    [...items]
      .sort(
        (left, right) =>
          Number(isTerminal(left)) - Number(isTerminal(right)) || right.updatedAt.localeCompare(left.updatedAt),
      )
      .slice(0, 20);

  const isTerminal = (item: MiniFilmActivityItem) =>
    item.mode === 'apply'
      ? terminalApplyStatuses.has(item.job.status)
      : terminalReviewStatuses.has(item.session.status);

  const upsertItem = (item: MiniFilmActivityItem) => {
    update((state) => {
      const items = state.items.filter((existing) => existing.mode !== item.mode || existing.id !== item.id);
      return { ...state, items: sortItems([item, ...items]) };
    });
  };

  const refresh = async () => {
    update((state) => ({ ...state, loading: true, error: undefined }));
    try {
      const [sessions, jobs] = await Promise.all([listMiniFilmReviewSessions(), listMiniFilmApplyJobs()]);
      set({
        loading: false,
        items: sortItems([
          ...sessions.map((session) => ({
            mode: 'review' as const,
            id: session.id,
            session,
            updatedAt: session.progress.updatedAt,
          })),
          ...jobs.map((job) => ({
            mode: 'apply' as const,
            id: job.id,
            job,
            updatedAt: job.progress.updatedAt,
          })),
        ]),
      });
    } catch (error) {
      update((state) => ({ ...state, loading: false, error: error instanceof Error ? error.message : String(error) }));
    }
  };

  const mergeEvent = (event: MiniFilmProgressEvent) => {
    update((state) => {
      const existing = state.items.find((item) => item.mode === event.mode && item.id === event.id);
      const fallback =
        event.mode === 'apply'
          ? ({
              mode: 'apply' as const,
              id: event.id,
              job: {
                id: event.id,
                status: event.status as MiniFilmApplyJob['status'],
                skippedAssets: [],
                rawAssetIds: [],
                total: event.progress.total,
                albumId: event.albumId,
                importedAssetIds: event.importedAssetIds,
                progress: event.progress,
              },
              updatedAt: event.progress.updatedAt,
            } satisfies MiniFilmActivityItem)
          : ({
              mode: 'review' as const,
              id: event.id,
              session: {
                id: event.id,
                name: 'mini-film review',
                status: event.status as MiniFilmReviewSession['status'],
                reviewUrl: `/api/mini-film/review-sessions/${event.id}/review/`,
                skippedAssets: [],
                importedAlbumId: event.albumId,
                importedAssetIds: event.importedAssetIds,
                progress: event.progress,
              },
              updatedAt: event.progress.updatedAt,
            } satisfies MiniFilmActivityItem);

      const nextItem =
        existing?.mode === 'apply'
          ? {
              ...existing,
              job: {
                ...existing.job,
                status: event.status as MiniFilmApplyJob['status'],
                albumId: event.albumId ?? existing.job.albumId,
                importedAssetIds: event.importedAssetIds ?? existing.job.importedAssetIds,
                progress: event.progress,
              },
              updatedAt: event.progress.updatedAt,
            }
          : existing?.mode === 'review'
            ? {
                ...existing,
                session: {
                  ...existing.session,
                  status: event.status as MiniFilmReviewSession['status'],
                  importedAlbumId: event.albumId ?? existing.session.importedAlbumId,
                  importedAssetIds: event.importedAssetIds ?? existing.session.importedAssetIds,
                  progress: event.progress,
                },
                updatedAt: event.progress.updatedAt,
              }
            : fallback;

      return {
        ...state,
        items: sortItems([nextItem, ...state.items.filter((item) => item.mode !== event.mode || item.id !== event.id)]),
      };
    });
  };

  const ensureSubscribed = () => {
    websocketCleanup ??= websocketEvents.on('on_mini_film_progress', mergeEvent);
  };

  const open = async (item?: MiniFilmActivityItem) => {
    ensureSubscribed();
    if (item) {
      upsertItem(item);
    }
    await refresh();
  };

  ensureSubscribed();

  return {
    subscribe,
    refresh,
    open,
    upsertItem,
  };
};

export const miniFilmProgressStore = createMiniFilmProgressStore();
