export type MiniFilmProfileLeaf = {
  name: string;
  path: string;
  relative: string;
};

export type MiniFilmProfileNode = {
  label: string;
  profiles: MiniFilmProfileLeaf[];
  children: MiniFilmProfileNode[];
};

export type MiniFilmProfileTree = {
  root: string;
  count: number;
  children: MiniFilmProfileNode[];
};

export type MiniFilmSkippedAsset = {
  id: string;
  originalFileName: string;
  reason: string;
};

export type MiniFilmReviewSession = {
  id: string;
  name: string;
  status: 'starting' | 'running' | 'stopped' | 'failed' | 'importing' | 'imported';
  reviewUrl: string;
  skippedAssets: MiniFilmSkippedAsset[];
  importedAlbumId?: string;
  importedAssetIds?: string[];
};

export type MiniFilmApplyJob = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  skippedAssets: MiniFilmSkippedAsset[];
  rawAssetIds: string[];
  total: number;
  albumId?: string;
  importedAssetIds?: string[];
};

export type MiniFilmImportResult = {
  albumId: string;
  assetIds: string[];
  imported: number;
  session: MiniFilmReviewSession;
};

type ReviewSessionRequest = {
  albumId?: string;
  assetIds?: string[];
  profiles?: string[];
  albumName?: string;
  name?: string;
};

type ApplyJobRequest = {
  assetIds: string[];
  profiles?: string[];
  albumName?: string;
};

const miniFilmFetch = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`/api/mini-film${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => undefined);
    throw new Error(body?.message || response.statusText);
  }

  return response.json() as Promise<T>;
};

export const getMiniFilmProfileTree = ({ includeAll = false }: { includeAll?: boolean } = {}) =>
  miniFilmFetch<MiniFilmProfileTree>(`/profiles${includeAll ? '?includeAll=true' : ''}`);

export const createMiniFilmReviewSession = (dto: ReviewSessionRequest) =>
  miniFilmFetch<MiniFilmReviewSession>('/review-sessions', {
    method: 'POST',
    body: JSON.stringify(dto),
  });

export const createMiniFilmApplyJob = (dto: ApplyJobRequest) =>
  miniFilmFetch<MiniFilmApplyJob>('/apply-jobs', {
    method: 'POST',
    body: JSON.stringify(dto),
  });

export const importMiniFilmReviewSession = (id: string, albumName?: string) =>
  miniFilmFetch<MiniFilmImportResult>(`/review-sessions/${id}/import`, {
    method: 'POST',
    body: JSON.stringify({ albumName }),
  });
