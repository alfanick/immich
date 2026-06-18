<script lang="ts">
  import { goto } from '$app/navigation';
  import MiniFilmActivityModal from '$lib/modals/MiniFilmActivityModal.svelte';
  import { Route } from '$lib/route';
  import {
    createMiniFilmApplyJob,
    createMiniFilmReviewSession,
    getMiniFilmProfileTree,
    importMiniFilmReviewSession,
    type MiniFilmProfileNode,
    type MiniFilmReviewSession,
  } from '$lib/services/mini-film.service';
  import { miniFilmProgressStore, type MiniFilmActivityItem } from '$lib/stores/mini-film-progress.store';
  import { Button, Checkbox, Field, FormModal, Input, Label, modalManager, toastManager } from '@immich/ui';
  import { mdiFilmstrip } from '@mdi/js';
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { t } from 'svelte-i18n';

  type ProfileRow =
    | { type: 'node'; id: string; label: string; depth: number }
    | { type: 'profile'; id: string; name: string; path: string; relative: string; depth: number };

  type Props = {
    onClose: (started?: boolean) => void;
    mode: 'review' | 'apply';
    assetIds?: string[];
    albumId?: string;
    defaultAlbumName?: string;
  };

  const { onClose, mode, assetIds = [], albumId, defaultAlbumName = '' }: Props = $props();

  let albumName = $state(defaultAlbumName);
  let profileNodes = $state<MiniFilmProfileNode[]>([]);
  let profileRoot = $state('');
  let profileSearch = $state('');
  let profileError = $state('');
  let loadingProfiles = $state(false);
  let submitting = $state(false);
  let reviewSession = $state<MiniFilmReviewSession>();
  const selectedProfiles = new SvelteSet<string>();

  const title = $derived(mode === 'review' ? 'mini-film review' : 'mini-film apply');
  const submitText = $derived(reviewSession ? 'Import to Immich' : mode === 'review' ? 'Start review' : 'Apply');

  const normalizeSearch = (value: string) =>
    value
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, ' ')
      .trim();

  const fuzzyMatchToken = (value: string, token: string) => {
    if (value.includes(token)) {
      return true;
    }

    let index = 0;
    for (const char of value) {
      if (char === token[index]) {
        index += 1;
      }
      if (index === token.length) {
        return true;
      }
    }
    return false;
  };

  const fuzzyMatch = (value: string, query: string) => {
    const normalizedValue = normalizeSearch(value);
    const tokens = normalizeSearch(query).split(/\s+/).filter(Boolean);
    return tokens.every((token) => fuzzyMatchToken(normalizedValue, token));
  };

  const profileMatches = (profile: ProfileRow & { type: 'profile' }, query: string) =>
    fuzzyMatch(`${profile.name} ${profile.relative} ${profile.path}`, query);

  const flattenProfiles = (nodes: MiniFilmProfileNode[], depth = 0, prefix = '', query = ''): ProfileRow[] => {
    const rows: ProfileRow[] = [];
    for (const node of nodes) {
      const id = `${prefix}/${node.label}`;
      const nodeMatches = fuzzyMatch(node.label, query);
      const profiles = node.profiles
        .map((profile) => ({ type: 'profile' as const, id: profile.path, depth: depth + 1, ...profile }))
        .filter((profile) => nodeMatches || profileMatches(profile, query));
      const children = flattenProfiles(node.children, depth + 1, id, query);
      if (!query || nodeMatches || profiles.length > 0 || children.length > 0) {
        rows.push({ type: 'node', id, label: node.label, depth }, ...profiles, ...children);
      }
    }
    return rows;
  };

  const profileRows = $derived(flattenProfiles(profileNodes, 0, '', profileSearch));

  const loadProfiles = async () => {
    loadingProfiles = true;
    profileError = '';
    try {
      const tree = await getMiniFilmProfileTree();
      profileRoot = tree.root;
      profileNodes = tree.children;
    } catch (error) {
      profileError = error instanceof Error ? error.message : String(error);
    } finally {
      loadingProfiles = false;
    }
  };

  const toggleProfile = (profile: string, checked: boolean) => {
    if (checked) {
      selectedProfiles.add(profile);
    } else {
      selectedProfiles.delete(profile);
    }
  };

  const showActivity = (item: MiniFilmActivityItem) => {
    miniFilmProgressStore.upsertItem(item);
    setTimeout(() => void modalManager.show(MiniFilmActivityModal, { item }), 0);
  };

  const onSubmit = async () => {
    submitting = true;
    try {
      if (reviewSession) {
        const result = await importMiniFilmReviewSession(reviewSession.id, albumName || undefined);
        reviewSession = result.session;
        showActivity({
          mode: 'review',
          id: result.session.id,
          session: result.session,
          updatedAt: result.session.progress.updatedAt,
        });
        toastManager.primary({
          description: 'mini-film import started',
          button: { label: $t('view_album'), onclick: () => goto(Route.viewAlbum({ id: result.albumId })) },
        });
        onClose(true);
        return;
      }

      const profiles = selectedProfiles.size > 0 ? [...selectedProfiles] : undefined;
      if (mode === 'review') {
        const session = await createMiniFilmReviewSession({
          albumId,
          assetIds: albumId ? undefined : assetIds,
          profiles,
          albumName: albumName || undefined,
        });
        reviewSession = session;
        showActivity({ mode: 'review', id: session.id, session, updatedAt: session.progress.updatedAt });
        toastManager.primary({
          description: `mini-film review started${session.skippedAssets.length > 0 ? `, skipped ${session.skippedAssets.length}` : ''}`,
          button: {
            label: 'View progress',
            onclick: () =>
              void modalManager.show(MiniFilmActivityModal, {
                item: { mode: 'review', id: session.id, session, updatedAt: session.progress.updatedAt },
              }),
          },
        });
        return;
      } else {
        const job = await createMiniFilmApplyJob({
          assetIds,
          profiles,
          albumName: albumName || undefined,
        });
        const item: MiniFilmActivityItem = {
          mode: 'apply',
          id: job.id,
          job,
          updatedAt: job.progress.updatedAt,
        };
        showActivity(item);
        const description = `mini-film apply queued for ${job.rawAssetIds.length} RAW asset${job.rawAssetIds.length === 1 ? '' : 's'}${
          job.skippedAssets.length > 0 ? `, skipped ${job.skippedAssets.length}` : ''
        }`;
        if (job.albumId) {
          toastManager.primary({
            description,
            button: {
              label: 'View progress',
              onclick: () => void modalManager.show(MiniFilmActivityModal, { item }),
            },
          });
        } else {
          toastManager.primary({
            description,
            button: {
              label: 'View progress',
              onclick: () => void modalManager.show(MiniFilmActivityModal, { item }),
            },
          });
        }
      }
      onClose(true);
    } catch (error) {
      toastManager.danger(error instanceof Error ? error.message : String(error));
    } finally {
      submitting = false;
    }
  };

  onMount(loadProfiles);
</script>

<FormModal {title} icon={mdiFilmstrip} {onClose} {onSubmit} {submitText} disabled={submitting} size="medium">
  <div class="flex flex-col gap-4">
    {#if reviewSession}
      <div class="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
        <div class="mb-2 text-sm font-medium text-primary">{reviewSession.name}</div>
        <Button
          size="small"
          color="secondary"
          shape="round"
          onclick={() => globalThis.open(reviewSession?.reviewUrl, '_blank')}
        >
          Open review
        </Button>
      </div>
    {/if}

    <Field label="Album name">
      <Input bind:value={albumName} />
    </Field>

    <section>
      <div class="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 class="text-sm font-medium text-primary">Profiles</h3>
          <p class="text-sm immich-form-label">{profileRoot || 'No profile root loaded'}</p>
        </div>
        <button
          type="button"
          class="rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50 dark:border-gray-700"
          disabled={loadingProfiles}
          onclick={loadProfiles}
        >
          {loadingProfiles ? 'Loading' : 'Refresh'}
        </button>
      </div>

      <Field label="Filter profiles">
        <Input bind:value={profileSearch} placeholder="Search by name or path" />
      </Field>

      {#if profileError}
        <p class="text-sm text-red-600">{profileError}</p>
      {/if}

      <div class="max-h-96 overflow-auto border-y border-gray-200 py-2 dark:border-gray-700">
        <div class="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          {#each profileRows as row (row.id)}
            {#if row.type === 'node'}
              <div class="col-span-2 py-1 font-medium text-primary" style:padding-left={`${row.depth * 16}px`}>
                {row.label}
              </div>
            {:else}
              <div class="truncate py-1" title={row.relative} style:padding-left={`${row.depth * 16}px`}>
                {row.name}
              </div>
              <Label class="flex justify-center py-1">
                <Checkbox
                  id={`mini-film-workflow-${row.path}`}
                  size="tiny"
                  checked={selectedProfiles.has(row.path)}
                  onCheckedChange={(checked) => toggleProfile(row.path, checked)}
                />
              </Label>
            {/if}
          {/each}
        </div>
      </div>
    </section>
  </div>
</FormModal>
