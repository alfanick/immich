<script lang="ts">
  import SettingInputField from '$lib/components/shared-components/settings/SettingInputField.svelte';
  import SettingSwitch from '$lib/components/shared-components/settings/SettingSwitch.svelte';
  import SettingButtonsRow from '$lib/components/shared-components/settings/SystemConfigButtonRow.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { getMiniFilmProfileTree, type MiniFilmProfileNode } from '$lib/services/mini-film.service';
  import { Checkbox, Label } from '@immich/ui';
  import { onMount } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { fade } from 'svelte/transition';
  import SettingSelect from './SettingSelect.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';

  type ProfileRow =
    | { type: 'node'; id: string; label: string; depth: number }
    | { type: 'profile'; id: string; name: string; path: string; relative: string; depth: number };

  const disabled = $derived(featureFlagsManager.value.configFile);
  const config = $derived(systemConfigManager.value);
  let configToEdit = $state(systemConfigManager.cloneValue());
  let profileRows = $state<ProfileRow[]>([]);
  let profileRoot = $state('');
  let profileError = $state('');
  let loadingProfiles = $state(false);

  const allowedProfiles = $derived(new SvelteSet(configToEdit.miniFilm.allowedProfiles));
  const defaultProfiles = $derived(new SvelteSet(configToEdit.miniFilm.defaultProfiles));
  const profilePaths = $derived(profileRows.flatMap((row) => (row.type === 'profile' ? [row.path] : [])));
  const allProfilesAllowed = $derived(configToEdit.miniFilm.allowedProfiles.length === 0);

  const flattenProfiles = (nodes: MiniFilmProfileNode[], depth = 0, prefix = ''): ProfileRow[] => {
    const rows: ProfileRow[] = [];
    for (const node of nodes) {
      const id = `${prefix}/${node.label}`;
      rows.push({ type: 'node', id, label: node.label, depth });
      for (const profile of node.profiles) {
        rows.push({ type: 'profile', id: profile.path, depth: depth + 1, ...profile });
      }
      rows.push(...flattenProfiles(node.children, depth + 1, id));
    }
    return rows;
  };

  const loadProfiles = async () => {
    loadingProfiles = true;
    profileError = '';
    try {
      const tree = await getMiniFilmProfileTree({ includeAll: true });
      profileRoot = tree.root;
      profileRows = flattenProfiles(tree.children);
    } catch (error) {
      profileError = error instanceof Error ? error.message : String(error);
    } finally {
      loadingProfiles = false;
    }
  };

  const normalizeAllowedProfiles = (values: string[]) => {
    const unique = [...new Set(values)];
    const visibleProfiles = new Set(profilePaths);
    if (
      profilePaths.length > 0 &&
      unique.length === profilePaths.length &&
      unique.every((value) => visibleProfiles.has(value))
    ) {
      return [];
    }
    return unique;
  };

  const toggleProfile = (key: 'allowedProfiles' | 'defaultProfiles', profile: string, checked: boolean) => {
    if (key === 'allowedProfiles') {
      let values = configToEdit.miniFilm.allowedProfiles;
      if (allProfilesAllowed && !checked) {
        values = profilePaths;
      }
      values = values.filter((value) => value !== profile);
      if (checked) {
        values.push(profile);
      }
      configToEdit.miniFilm.allowedProfiles = normalizeAllowedProfiles(values);
      return;
    }

    const values = configToEdit.miniFilm[key].filter((value) => value !== profile);
    if (checked) {
      values.push(profile);
    }
    configToEdit.miniFilm[key] = values;
  };

  onMount(loadProfiles);
</script>

<div class="mt-2">
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" class="mx-4 mt-4" onsubmit={(event) => event.preventDefault()}>
      <div class="ms-4 mt-4 flex flex-col gap-4">
        <SettingSwitch
          title="Enable mini-film"
          bind:checked={configToEdit.miniFilm.enabled}
          isEdited={configToEdit.miniFilm.enabled !== config.miniFilm.enabled}
          {disabled}
        />

        <div class="grid gap-4 md:grid-cols-2">
          <SettingInputField
            inputType={SettingInputFieldType.TEXT}
            label="mini-film binary"
            bind:value={configToEdit.miniFilm.binaryPath}
            isEdited={configToEdit.miniFilm.binaryPath !== config.miniFilm.binaryPath}
            {disabled}
          />
          <SettingInputField
            inputType={SettingInputFieldType.TEXT}
            label="Workspace root"
            bind:value={configToEdit.miniFilm.workRoot}
            isEdited={configToEdit.miniFilm.workRoot !== config.miniFilm.workRoot}
            {disabled}
          />
          <SettingInputField
            inputType={SettingInputFieldType.TEXT}
            label="Profiles root"
            bind:value={configToEdit.miniFilm.profilesRoot}
            isEdited={configToEdit.miniFilm.profilesRoot !== config.miniFilm.profilesRoot}
            {disabled}
          />
          <SettingInputField
            inputType={SettingInputFieldType.TEXT}
            label="Hald cache"
            bind:value={configToEdit.miniFilm.haldDir}
            isEdited={configToEdit.miniFilm.haldDir !== config.miniFilm.haldDir}
            {disabled}
          />
          <SettingInputField
            inputType={SettingInputFieldType.TEXT}
            label="LCP root"
            bind:value={configToEdit.miniFilm.lcpRoot}
            isEdited={configToEdit.miniFilm.lcpRoot !== config.miniFilm.lcpRoot}
            {disabled}
          />
          <SettingInputField
            inputType={SettingInputFieldType.TEXT}
            label="rawtherapee-cli"
            bind:value={configToEdit.miniFilm.rawtherapeePath}
            isEdited={configToEdit.miniFilm.rawtherapeePath !== config.miniFilm.rawtherapeePath}
            {disabled}
          />
          <SettingInputField
            inputType={SettingInputFieldType.TEXT}
            label="convert"
            bind:value={configToEdit.miniFilm.convertPath}
            isEdited={configToEdit.miniFilm.convertPath !== config.miniFilm.convertPath}
            {disabled}
          />
          <SettingInputField
            inputType={SettingInputFieldType.TEXT}
            label="Publish folder"
            bind:value={configToEdit.miniFilm.publishAlbum}
            isEdited={configToEdit.miniFilm.publishAlbum !== config.miniFilm.publishAlbum}
            {disabled}
          />
        </div>

        <div class="grid gap-4 md:grid-cols-4">
          <SettingInputField
            inputType={SettingInputFieldType.NUMBER}
            label="Default jobs"
            bind:value={configToEdit.miniFilm.defaultJobs}
            min={1}
            max={64}
            isEdited={configToEdit.miniFilm.defaultJobs !== config.miniFilm.defaultJobs}
            {disabled}
          />
          <SettingInputField
            inputType={SettingInputFieldType.NUMBER}
            label="Max jobs"
            bind:value={configToEdit.miniFilm.maxJobs}
            min={1}
            max={64}
            isEdited={configToEdit.miniFilm.maxJobs !== config.miniFilm.maxJobs}
            {disabled}
          />
          <SettingInputField
            inputType={SettingInputFieldType.NUMBER}
            label="Port start"
            bind:value={configToEdit.miniFilm.reviewPortStart}
            min={1}
            max={65_535}
            isEdited={configToEdit.miniFilm.reviewPortStart !== config.miniFilm.reviewPortStart}
            {disabled}
          />
          <SettingInputField
            inputType={SettingInputFieldType.NUMBER}
            label="Port end"
            bind:value={configToEdit.miniFilm.reviewPortEnd}
            min={1}
            max={65_535}
            isEdited={configToEdit.miniFilm.reviewPortEnd !== config.miniFilm.reviewPortEnd}
            {disabled}
          />
        </div>

        <div class="grid gap-4 md:grid-cols-4">
          <SettingSelect
            label="Output format"
            bind:value={configToEdit.miniFilm.outputFormat}
            name="mini-film-output-format"
            options={[
              { value: 'jpg', text: 'JPG' },
              { value: 'tiff', text: 'TIFF' },
            ]}
            isEdited={configToEdit.miniFilm.outputFormat !== config.miniFilm.outputFormat}
            {disabled}
          />
          <SettingInputField
            inputType={SettingInputFieldType.NUMBER}
            label="JPEG quality"
            bind:value={configToEdit.miniFilm.jpgQuality}
            min={1}
            max={100}
            isEdited={configToEdit.miniFilm.jpgQuality !== config.miniFilm.jpgQuality}
            {disabled}
          />
          <SettingSelect
            label="JPEG subsampling"
            bind:value={configToEdit.miniFilm.jpegSubsampling}
            name="mini-film-jpeg-subsampling"
            options={[
              { value: 's444', text: '4:4:4' },
              { value: 's422', text: '4:2:2' },
              { value: 's420', text: '4:2:0' },
            ]}
            isEdited={configToEdit.miniFilm.jpegSubsampling !== config.miniFilm.jpegSubsampling}
            {disabled}
          />
          <SettingInputField
            inputType={SettingInputFieldType.NUMBER}
            label="Long edge"
            bind:value={configToEdit.miniFilm.longEdge}
            min={0}
            isEdited={configToEdit.miniFilm.longEdge !== config.miniFilm.longEdge}
            {disabled}
          />
        </div>

        <div class="grid gap-4 md:grid-cols-4">
          <SettingSelect
            label="Gallery"
            bind:value={configToEdit.miniFilm.gallery}
            name="mini-film-gallery"
            options={[
              { value: '', text: 'None' },
              { value: 'modern', text: 'Modern' },
              { value: 'soft', text: 'Soft' },
              { value: 'compact', text: 'Compact' },
              { value: 'hero', text: 'Hero' },
              { value: 'phone', text: 'Phone' },
              { value: 'all', text: 'All' },
            ]}
            isEdited={configToEdit.miniFilm.gallery !== config.miniFilm.gallery}
            {disabled}
          />
          <SettingInputField
            inputType={SettingInputFieldType.NUMBER}
            label="Gallery thumb edge"
            bind:value={configToEdit.miniFilm.galleryThumbnailLongEdge}
            min={1}
            isEdited={configToEdit.miniFilm.galleryThumbnailLongEdge !== config.miniFilm.galleryThumbnailLongEdge}
            {disabled}
          />
          <SettingInputField
            inputType={SettingInputFieldType.NUMBER}
            label="Gallery columns"
            bind:value={configToEdit.miniFilm.galleryColumns}
            min={1}
            max={20}
            isEdited={configToEdit.miniFilm.galleryColumns !== config.miniFilm.galleryColumns}
            {disabled}
          />
          <SettingInputField
            inputType={SettingInputFieldType.NUMBER}
            label="Color noise ISO"
            bind:value={configToEdit.miniFilm.colorNoiseIsoThreshold}
            min={0}
            isEdited={configToEdit.miniFilm.colorNoiseIsoThreshold !== config.miniFilm.colorNoiseIsoThreshold}
            {disabled}
          />
        </div>

        <div class="grid gap-4 md:grid-cols-3">
          <SettingInputField
            inputType={SettingInputFieldType.TEXT}
            label="Lens corrections"
            bind:value={configToEdit.miniFilm.lensCorrections}
            isEdited={configToEdit.miniFilm.lensCorrections !== config.miniFilm.lensCorrections}
            {disabled}
          />
          <SettingSelect
            label="Grain preset"
            bind:value={configToEdit.miniFilm.grainPreset}
            name="mini-film-grain-preset"
            options={[
              { value: '', text: 'Default' },
              { value: 'light', text: 'Light' },
              { value: 'medium', text: 'Medium' },
              { value: 'heavy', text: 'Heavy' },
            ]}
            isEdited={configToEdit.miniFilm.grainPreset !== config.miniFilm.grainPreset}
            {disabled}
          />
          <SettingInputField
            inputType={SettingInputFieldType.TEXT}
            label="Grain"
            bind:value={configToEdit.miniFilm.grain}
            isEdited={configToEdit.miniFilm.grain !== config.miniFilm.grain}
            {disabled}
          />
        </div>

        <SettingSwitch
          title="Progressive JPEG"
          bind:checked={configToEdit.miniFilm.progressive}
          isEdited={configToEdit.miniFilm.progressive !== config.miniFilm.progressive}
          {disabled}
        />
        <SettingSwitch
          title="Strip metadata"
          bind:checked={configToEdit.miniFilm.stripMetadata}
          isEdited={configToEdit.miniFilm.stripMetadata !== config.miniFilm.stripMetadata}
          {disabled}
        />
        <SettingSwitch
          title="Disable grain"
          bind:checked={configToEdit.miniFilm.noGrain}
          isEdited={configToEdit.miniFilm.noGrain !== config.miniFilm.noGrain}
          {disabled}
        />

        <section class="mt-2">
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

          {#if profileError}
            <p class="text-sm text-red-600">{profileError}</p>
          {/if}

          <div class="max-h-96 overflow-auto border-y border-gray-200 py-2 dark:border-gray-700">
            <div class="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1 text-sm">
              <div class="font-medium">Profile</div>
              <div class="font-medium">Default</div>
              <div class="font-medium">Allowed</div>
              {#each profileRows as row (row.id)}
                {#if row.type === 'node'}
                  <div class="col-span-3 py-1 font-medium text-primary" style:padding-left={`${row.depth * 16}px`}>
                    {row.label}
                  </div>
                {:else}
                  <div class="truncate py-1" title={row.relative} style:padding-left={`${row.depth * 16}px`}>
                    {row.name}
                  </div>
                  <Label class="flex justify-center py-1">
                    <Checkbox
                      id={`mini-film-default-${row.path}`}
                      size="tiny"
                      checked={defaultProfiles.has(row.path)}
                      {disabled}
                      onCheckedChange={(checked) => toggleProfile('defaultProfiles', row.path, checked)}
                    />
                  </Label>
                  <Label class="flex justify-center py-1">
                    <Checkbox
                      id={`mini-film-allowed-${row.path}`}
                      size="tiny"
                      checked={allProfilesAllowed || allowedProfiles.has(row.path)}
                      {disabled}
                      onCheckedChange={(checked) => toggleProfile('allowedProfiles', row.path, checked)}
                    />
                  </Label>
                {/if}
              {/each}
            </div>
          </div>
        </section>
      </div>

      <SettingButtonsRow bind:configToEdit keys={['miniFilm']} {disabled} />
    </form>
  </div>
</div>
