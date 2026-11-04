// GameBanana: an open catalogue (no key, no account API). A mod is a set of
// uploaded archives, each with an MD5 checksum; every file is offered as a version.
import type { GameContext, ModProject, ModRef, ModVersion, SearchQuery, SearchResult } from '../../../shared/types';
import type { ProjectMeta } from '../resolver';
import { getJson } from '../http';
import { gameDef } from '../games';
import type { SourceAdapter } from './types';

const API = 'https://gamebanana.com/apiv11';
const PER_PAGE = 15;

interface GbImage {
  _sBaseUrl: string;
  _sFile: string;
  _sFile100?: string;
  _sFile220?: string;
}

interface GbRecord {
  _idRow: number;
  _sName: string;
  _sModelName?: string;
  _sProfileUrl?: string;
  _tsDateAdded?: number;
  _tsDateModified?: number;
  _aSubmitter?: { _sName?: string };
  _aPreviewMedia?: { _aImages?: GbImage[] };
  _aRootCategory?: { _sName?: string };
  _aCategory?: { _sName?: string };
  _nDownloadCount?: number | null;
  _sVersion?: string;
  _bIsObsolete?: boolean;
}

interface GbFile {
  _idRow: number;
  _sFile: string;
  _nFilesize?: number;
  _tsDateAdded?: number;
  _sDownloadUrl: string;
  _sMd5Checksum?: string;
  _sVersion?: string;
  _sAvResult?: string;
  _bIsArchived?: boolean;
}

interface GbProfile extends GbRecord {
  _aFiles?: GbFile[];
  _aGame?: { _idRow: number };
}

const iso = (ts?: number) => (ts ? new Date(ts * 1000).toISOString() : '');

function image(r: GbRecord): string | undefined {
  const i = r._aPreviewMedia?._aImages?.[0];
  return i ? `${i._sBaseUrl}/${i._sFile220 ?? i._sFile100 ?? i._sFile}` : undefined;
}

export function gbToProject(r: GbRecord): ModProject {
  const category = r._aRootCategory?._sName ?? r._aCategory?._sName;
  return {
    ref: { source: 'gamebanana', projectId: String(r._idRow) },
    title: r._sName,
    summary: category ?? '',
    author: r._aSubmitter?._sName ?? '',
    iconUrl: image(r),
    downloads: r._nDownloadCount ?? 0,
    updated: iso(r._tsDateModified ?? r._tsDateAdded),
    categories: category ? [category] : [],
    url: r._sProfileUrl ?? `https://gamebanana.com/mods/${r._idRow}`,
    kind: 'mod',
  };
}

/** Files of a mod as versions, newest first; archived and flagged files are left out. */
export function gbVersions(ref: ModRef, p: GbProfile): ModVersion[] {
  const files = (p._aFiles ?? []).filter((f) => !f._bIsArchived && (!f._sAvResult || f._sAvResult === 'clean'));
  files.sort((a, b) => (b._tsDateAdded ?? 0) - (a._tsDateAdded ?? 0));
  return files.map((f) => ({
    ref,
    versionId: String(f._idRow),
    version: f._sVersion || p._sVersion || iso(f._tsDateAdded).slice(0, 10) || String(f._idRow),
    name: f._sFile,
    gameVersions: [],
    loaders: [],
    published: iso(f._tsDateAdded),
    files: [{ url: f._sDownloadUrl, filename: f._sFile, size: f._nFilesize, hashes: f._sMd5Checksum ? { md5: f._sMd5Checksum.toLowerCase() } : {}, primary: true }],
    deps: [],
  }));
}

export class GameBananaSource implements SourceAdapter {
  private profile(id: string) {
    return getJson<GbProfile>(`${API}/Mod/${encodeURIComponent(id)}/ProfilePage`, {}, 10 * 60_000);
  }

  async search(q: SearchQuery): Promise<SearchResult> {
    const game = gameDef(q.ctx.gameDefId)?.gamebananaId;
    if (!game) return { hits: [], total: 0, offset: 0 };
    const page = Math.floor((q.offset ?? 0) / PER_PAGE) + 1;
    const text = q.text.trim();
    const url = text
      ? `${API}/Util/Search/Results?_sModelName=Mod&_sOrder=best_match&_idGameRow=${game}&_sSearchString=${encodeURIComponent(text)}&_nPage=${page}`
      : `${API}/Mod/Index?_nPage=${page}&_nPerpage=${PER_PAGE}&_aFilters%5BGeneric_Game%5D=${game}&_sSort=Generic_MostDownloaded`;
    const res = await getJson<{ _aMetadata?: { _nRecordCount?: number }; _aRecords?: GbRecord[] }>(url);
    const hits = (res._aRecords ?? []).filter((r) => (r._sModelName ?? 'Mod') === 'Mod' && !r._bIsObsolete).map(gbToProject);
    return { hits, total: res._aMetadata?._nRecordCount ?? hits.length, offset: (page - 1) * PER_PAGE };
  }

  async versions(ref: ModRef, _ctx: GameContext): Promise<ModVersion[]> {
    return gbVersions(ref, await this.profile(ref.projectId));
  }

  async project(ref: ModRef): Promise<ModProject | null> {
    return gbToProject(await this.profile(ref.projectId));
  }

  async meta(refs: ModRef[]): Promise<Map<string, ProjectMeta>> {
    const out = new Map<string, ProjectMeta>();
    for (const r of refs) {
      const p = await this.profile(r.projectId).catch(() => null);
      if (p) out.set(`gamebanana:${r.projectId}`, { title: p._sName, author: p._aSubmitter?._sName, iconUrl: image(p) });
    }
    return out;
  }
}
