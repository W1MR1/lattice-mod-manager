// CurseForge (Minecraft). The API needs a key that CurseForge issues to an
// application (console.curseforge.com); without one the source stays off. There
// is no user sign-in. Authors may forbid downloads by third-party apps: such
// files come without a link and have to be fetched from the website.
import type { DepDecl, GameContext, ModProject, ModRef, ModVersion, ProjectKind, SearchQuery, SearchResult } from '../../../shared/types';
import type { ProjectMeta } from '../resolver';
import { getJson, HttpError, postJson } from '../http';
import { gameDef } from '../games';
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

/** Slugs a game may have on CurseForge; the list itself comes from CurseForge. */
const CF_SLUGS: Record<string, string[]> = {
  stardewvalley: ['stardewvalley', 'stardew-valley'],
  cyberpunk2077: ['cyberpunk2077', 'cyberpunk-2077'],
  valheim: ['valheim'],
  skyrimse: ['skyrim-special-edition', 'skyrimse', 'skyrim'],
  fallout4: ['fallout-4', 'fallout4'],
  'lethal-company': ['lethal-company', 'lethalcompany'],
  riskofrain2: ['risk-of-rain-2', 'riskofrain2'],
  'content-warning': ['content-warning', 'contentwarning'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export class CurseForgeSource implements SourceAdapter {
  constructor(private key: () => string | undefined) {}

  private gamesList: Promise<{ id: number; name: string; slug: string }[]> | null = null;
  private classes = new Map<number, Promise<{ id: number; name: string; slug: string }[]>>();

  available() {
    return !!this.key();
  }

  private headers(): Record<string, string> {
    const key = this.key();
    if (!key) throw new Error(t('Для CurseForge нужен ключ API: его выдаёт CurseForge (console.curseforge.com). Укажите его в настройках или соберите Lattice с ключом.'));
    return { 'x-api-key': key };
  }

  /** CurseForge answers 403 to a key it does not accept: say what kind of key it wants. */
  private async get<T>(url: string, ttl?: number): Promise<T> {
    try {
      return await getJson<T>(url, this.headers(), ttl);
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        throw new Error(
          t('CurseForge не принял ключ ({0}). Нужен ключ Core API из console.curseforge.com — он выглядит как $2a$10$… и работает после одобрения заявки CurseForge. Токен автора с сайта curseforge.com для этого не подходит.', e.status),
        );
      }
      throw e;
    }
  }

  /** Checks the key: the number of games CurseForge lists for it. */
  async check(): Promise<number> {
    return (await this.games()).length;
  }

  private games() {
    this.gamesList ??= (async () => {
      const out: { id: number; name: string; slug: string }[] = [];
      for (let index = 0; index < 1000; index += 50) {
        const res = await this.get<{ data: { id: number; name: string; slug: string }[] }>(`${API}/games?index=${index}&pageSize=50`, 3_600_000);
        out.push(...res.data);
        if (res.data.length < 50) break;
      }
      return out;
    })().catch((e) => {
      this.gamesList = null;
      throw e;
    });
    return this.gamesList;
  }

  /** CurseForge game id of a Lattice game, or null when CurseForge does not have it. */
  async gameIdFor(defId: string): Promise<number | null> {
    if (defId === 'minecraft') return MINECRAFT;
    const games = await this.games();
    const slugs = CF_SLUGS[defId] ?? [];
    const name = norm(gameDef(defId)?.name ?? '');
    return games.find((g) => slugs.includes(g.slug) || (name && norm(g.name) === name))?.id ?? null;
  }

  private async classId(gameId: number, kind: ProjectKind): Promise<number | undefined> {
    if (gameId === MINECRAFT) return CLASS[kind] ?? 6;
    let p = this.classes.get(gameId);
    if (!p) {
      p = this.get<{ data: { id: number; name: string; slug: string }[] }>(`${API}/categories?gameId=${gameId}&classesOnly=true`, 3_600_000).then((r) => r.data);
      this.classes.set(gameId, p);
    }
    const list = await p;
    const want: Record<string, RegExp> = { mod: /^(mc-)?mods$|^mods?$/i, modpack: /modpacks?/i, resourcepack: /texture|resource/i, shader: /shader/i };
    return list.find((c) => want[kind]?.test(c.slug) || want[kind]?.test(c.name))?.id;
  }

  async search(q: SearchQuery): Promise<SearchResult> {
    const gameId = await this.gameIdFor(q.ctx.gameDefId);
    if (!gameId) return { hits: [], total: 0, offset: 0 };
    const offset = q.offset ?? 0;
    const classId = await this.classId(gameId, q.kind ?? 'mod');
    const params = new URLSearchParams({ gameId: String(gameId), sortField: '2', sortOrder: 'desc', index: String(offset), pageSize: '20' });
    if (classId) params.set('classId', String(classId));
    if (q.text.trim()) params.set('searchFilter', q.text.trim());
    if (q.compatibleOnly && gameId === MINECRAFT && q.ctx.gameVersion) params.set('gameVersion', q.ctx.gameVersion);
    if (q.compatibleOnly && gameId === MINECRAFT && q.ctx.loader && LOADER_TYPE[q.ctx.loader] && (q.kind ?? 'mod') === 'mod') params.set('modLoaderType', String(LOADER_TYPE[q.ctx.loader]));
    const res = await this.get<{ data: CfMod[]; pagination?: { totalCount?: number } }>(`${API}/mods/search?${params}`);
    // CurseForge pages no further than 10 000 results
    return { hits: res.data.map(cfToProject), total: Math.min(res.pagination?.totalCount ?? res.data.length, 10_000), offset };
  }

  async versions(ref: ModRef, ctx: GameContext): Promise<ModVersion[]> {
    const params = new URLSearchParams({ pageSize: '50', index: '0' });
    if (ctx.gameDefId === 'minecraft' && ctx.gameVersion) params.set('gameVersion', ctx.gameVersion);
    if (ctx.gameDefId === 'minecraft' && ctx.loader && LOADER_TYPE[ctx.loader]) params.set('modLoaderType', String(LOADER_TYPE[ctx.loader]));
    const res = await this.get<{ data: CfFile[] }>(`${API}/mods/${encodeURIComponent(ref.projectId)}/files?${params}`);
    return res.data.filter((f) => f.isAvailable !== false).map((f) => cfToVersion(ref, f));
  }

  async project(ref: ModRef): Promise<ModProject | null> {
    const res = await this.get<{ data: CfMod }>(`${API}/mods/${encodeURIComponent(ref.projectId)}`);
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
