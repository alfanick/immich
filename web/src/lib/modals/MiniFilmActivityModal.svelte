<script lang="ts">
  import { goto } from '$app/navigation';
  import { Route } from '$lib/route';
  import { importMiniFilmReviewSession, type MiniFilmProgress } from '$lib/services/mini-film.service';
  import { miniFilmProgressStore, type MiniFilmActivityItem } from '$lib/stores/mini-film-progress.store';
  import { Button, Modal, ModalBody, ProgressBar, toastManager } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    onClose: () => void;
    item?: MiniFilmActivityItem;
  };

  const { onClose, item }: Props = $props();
  let importingId = $state<string>();

  const label = (progress: MiniFilmProgress) => {
    const counts = progress.total > 0 ? `${progress.processed}/${progress.total}` : progress.stage;
    return progress.imported === undefined ? counts : `${counts} · ${progress.imported} imported`;
  };

  const progressText = (progress: MiniFilmProgress) =>
    progress.total > 0 ? `${Math.round(progress.percent * 100)}%` : progress.stage;

  const title = (activity: MiniFilmActivityItem) =>
    activity.mode === 'apply'
      ? `mini-film apply ${activity.job.status}`
      : `${activity.session.name || 'mini-film review'} ${activity.session.status}`;

  const progress = (activity: MiniFilmActivityItem) =>
    activity.mode === 'apply' ? activity.job.progress : activity.session.progress;

  const albumId = (activity: MiniFilmActivityItem) =>
    activity.mode === 'apply' ? activity.job.albumId : activity.session.importedAlbumId;

  const openReview = (activity: MiniFilmActivityItem) => {
    if (activity.mode === 'review') {
      globalThis.open(activity.session.reviewUrl, '_blank');
    }
  };

  const importReview = async (activity: MiniFilmActivityItem) => {
    if (activity.mode !== 'review') {
      return;
    }

    importingId = activity.id;
    try {
      const result = await importMiniFilmReviewSession(activity.id, activity.session.name || undefined);
      toastManager.primary({
        description: 'mini-film import started',
        button: { label: $t('view_album'), onclick: () => goto(Route.viewAlbum({ id: result.albumId })) },
      });
      miniFilmProgressStore.upsertItem({
        mode: 'review',
        id: result.session.id,
        session: result.session,
        updatedAt: result.session.progress.updatedAt,
      });
    } catch (error) {
      toastManager.danger(error instanceof Error ? error.message : String(error));
    } finally {
      importingId = undefined;
    }
  };

  onMount(() => {
    void miniFilmProgressStore.open(item);
  });
</script>

<Modal title="mini-film activity" size="medium" {onClose}>
  <ModalBody>
    <div class="flex max-h-[70vh] flex-col gap-3 overflow-y-auto px-1 pb-2">
      {#if $miniFilmProgressStore.loading}
        <p class="text-sm immich-form-label">Loading</p>
      {/if}

      {#if $miniFilmProgressStore.error}
        <p class="text-sm text-red-600">{$miniFilmProgressStore.error}</p>
      {/if}

      {#if !$miniFilmProgressStore.loading && $miniFilmProgressStore.items.length === 0}
        <p class="text-sm immich-form-label">No mini-film activity</p>
      {/if}

      {#each $miniFilmProgressStore.items as activity (`${activity.mode}:${activity.id}`)}
        {@const activityProgress = progress(activity)}
        {@const activityAlbumId = albumId(activity)}
        <section class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
          <div class="mb-3 flex items-start justify-between gap-3">
            <div class="min-w-0">
              <h3 class="truncate text-sm font-medium text-primary" title={title(activity)}>
                {title(activity)}
              </h3>
              <p class="truncate text-xs immich-form-label" title={activityProgress.message}>
                {activityProgress.message || activityProgress.stage}
              </p>
            </div>
            <div class="shrink-0 text-xs immich-form-label">{progressText(activityProgress)}</div>
          </div>

          <ProgressBar progress={activityProgress.percent} size="small" label={label(activityProgress)} />

          <div class="mt-3 grid grid-cols-1 gap-2 text-xs immich-form-label sm:grid-cols-2">
            {#if activityProgress.currentFile}
              <div class="truncate" title={activityProgress.currentFile}>{activityProgress.currentFile}</div>
            {/if}
            {#if activityProgress.currentProfile}
              <div class="truncate" title={activityProgress.currentProfile}>{activityProgress.currentProfile}</div>
            {/if}
            {#if activityProgress.skipped}
              <div>{activityProgress.skipped} skipped</div>
            {/if}
          </div>

          <div class="mt-3 flex flex-wrap justify-end gap-2">
            {#if activity.mode === 'review' && activity.session.status === 'running'}
              <Button size="small" color="secondary" shape="round" onclick={() => openReview(activity)}>
                Open review
              </Button>
              {#if !activity.session.importedAlbumId}
                <Button
                  size="small"
                  shape="round"
                  disabled={importingId === activity.id}
                  onclick={() => importReview(activity)}
                >
                  Import to Immich
                </Button>
              {/if}
            {/if}
            {#if activityAlbumId}
              <Button
                size="small"
                color="secondary"
                shape="round"
                onclick={() => goto(Route.viewAlbum({ id: activityAlbumId }))}
              >
                {$t('view_album')}
              </Button>
            {/if}
          </div>
        </section>
      {/each}
    </div>
  </ModalBody>
</Modal>
