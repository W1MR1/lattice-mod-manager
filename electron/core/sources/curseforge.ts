// CurseForge (Minecraft). The API needs a key that CurseForge issues to an
// application (console.curseforge.com); without one the source stays off. There
// is no user sign-in. Authors may forbid downloads by third-party apps: such
// files come without a link and have to be fetched from the website.
import type { DepDecl, GameContext, ModProject, ModRef, ModVersion, ProjectKind, SearchQuery, SearchResult } from '../../../shared/types';
import type { ProjectMeta } from '../resolver';
import { getJson, postJson } from '../http';
import type { SourceAdapter } from './types';
import { t } from '../../../shared/i18n';

const API = 'https://api.curseforge.com/v1';
const MINECRAFT = 432;
const CLASS: Partial<Record<ProjectKind, number>> = { mod: 6, modpack: 4471, resourcepack: 12, shader: 6552 };
const KIND_OF_CLASS: Record<number, ProjectKind> = { 6: 'mod', 4471: 'modpack', 12: 'resourcepack', 6552: 'shader' };
const LOADER_TYPE: Record<string, number> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
const LOADERS = new Set(['forge', 'fabric', 'quilt', 'neoforge']);

export interface CfMod {
  id: number;
  name: string;
  slug?: string;
  summary?: string;
  downloadCount?: number;
  dateModified?: string;
  classId?: number;
  links?: { websiteUrl?: string };
  logo?: { thumbnailUrl?: string; url?: string };
  authors?: { name: string }[];
  categories?: { name: string }[];
}

export interface CfFile {
  id: number;
  modId?: number;
  displayName: string;
  fileName: string;
  fileDate: string;
  fileLength?: number;
  downloadUrl: string | null;
  hashes?: { value: string; algo: number }[];
  gameVersions?: string[];
  dependencies?: { modId: number; relationType: number }[];
  isAvailable?: boolean;
}

export function cfToProject(m: CfMod): ModProject {
  return {
    ref: { source: 'curseforge', projectId: String(m.id) },
    title: m.name,
    summary: m.summary ?? '',
    author: m.authors?.[0]?.name ?? '',
    iconUrl: m.logo?.thumbnailUrl ?? m.logo?.url,
    downloads: m.downloadCount ?? 0,
    updated: m.dateModified ?? '',
    categories: (m.categories ?? []).map((c) => c.name),
    url: m.links?.websiteUrl ?? `https://www.curseforge.com/minecraft/mc-mods/${m.slug ?? m.id}`,
    kind: KIND_OF_CLASS[m.classId ?? 6] ?? 'mod',
  };
}

const RELATION: Record<number, DepDecl['kind'] | undefined> = { 3: 'requires', 2: 'recommends', 5: 'conflicts' };

/** A CurseForge file as a version: Minecraft versions and loaders come mixed in gameVersions. */
export function cfToVersion(ref: ModRef, f: CfFile): ModVersion {
  const tags = f.gameVersions ?? [];
  const sha1 = f.hashes?.find((h) => h.algo === 1)?.value;
  const md5 = f.hashes?.find((h) => h.algo === 2)?.value;
  return {
    ref,
    versionId: String(f.id),
    version: f.displayName || f.fileName,
    name: f.fileName,
    gameVersions: tags.filter((v) => /^\d+\.\d+(\.\d+)?(-[\w.]+)?$/.test(v)),
    loaders: tags.map((v) => v.toLowerCase()).filter((v) => LOADERS.has(v)),
    published: f.fileDate,
    // no link: the author allows downloads on curseforge.com only
    files: f.downloadUrl ? [{ url: f.downloadUrl, filename: f.fileName, size: f.fileLength, hashes: { ...(sha1 ? { sha1 } : {}), ...(md5 ? { md5 } : {}) }, primary: true }] : [],
    deps: (f.dependencies ?? [])
      .filter((d) => RELATION[d.relationType])
      .map((d) => ({ ref: { source: 'curseforge' as const, projectId: String(d.modId) }, kind: RELATION[d.relationType]! })),
  };
}

export class CurseForgeSource implements SourceAdapter {
  constructor(private key: () => string | undefined) {}

  available() {
    return !!this.key();
  }

  private headers(): Record<string, string> {
    const key = this.key();
    if (!key) throw new Error(t('Для CurseForge нужен ключ API: его выдаёт CurseForge (console.curseforge.com). Укажите его в настройках или соберите Lattice с ключом.'));
    return { 'x-api-key': key };
  }

  async search(q: SearchQuery): Promise<SearchResult> {
    if (q.ctx.gameDefId !== 'minecraft') return { hits: [], total: 0, offset: 0 };
    const offset = q.offset ?? 0;
    const params = new URLSearchParams({ gameId: String(MINECRAFT), classId: String(CLASS[q.kind ?? 'mod'] ?? 6), sortField: '2', sortOrder: 'desc', index: String(offset), pageSize: '20' });
    if (q.text.trim()) params.set('searchFilter', q.text.trim());
    if (q.compatibleOnly && q.ctx.gameVersion) params.set('gameVersion', q.ctx.gameVersion);
    if (q.compatibleOnly && q.ctx.loader && LOADER_TYPE[q.ctx.loader] && (q.kind ?? 'mod') === 'mod') params.set('modLoaderType', String(LOADER_TYPE[q.ctx.loader]));
    const res = await getJson<{ data: CfMod[]; pagination?: { totalCount?: number } }>(`${API}/mods/search?${params}`, this.headers());
    // CurseForge pages no further than 10 000 results
    return { hits: res.data.map(cfToProject), total: Math.min(res.pagination?.totalCount ?? res.data.length, 10_000), offset };
  }

  async versions(ref: ModRef, ctx: GameContext): Promise<ModVersion[]> {
    const params = new URLSearchParams({ pageSize: '50', index: '0' });
    if (ctx.gameVersion) params.set('gameVersion', ctx.gameVersion);
    if (ctx.loader && LOADER_TYPE[ctx.loader]) params.set('modLoaderType', String(LOADER_TYPE[ctx.loader]));
    const res = await getJson<{ data: CfFile[] }>(`${API}/mods/${encodeURIComponent(ref.projectId)}/files?${params}`, this.headers());
    return res.data.filter((f) => f.isAvailable !== false).map((f) => cfToVersion(ref, f));
  }

  async project(ref: ModRef): Promise<ModProject | null> {
    const res = await getJson<{ data: CfMod }>(`${API}/mods/${encodeURIComponent(ref.projectId)}`, this.headers());
    return cfToProject(res.data);
  }

  async meta(refs: ModRef[]): Promise<Map<string, ProjectMeta>> {
    const out = new Map<string, ProjectMeta>();
    if (!refs.length) return out;
    const res = await postJson<{ data: CfMod[] }>(`${API}/mods`, { modIds: refs.map((r) => Number(r.projectId)).filter(Number.isFinite) }, this.headers());
    for (const m of res.data) out.set(`curseforge:${m.id}`, { title: m.name, author: m.authors?.[0]?.name, iconUrl: m.logo?.thumbnailUrl });
    return out;
  }
}
