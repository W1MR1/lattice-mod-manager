// Modrinth API v2 (https://docs.modrinth.com). Public, no key, CDN without speed caps.
import type { DepKind, GameContext, ModProject, ModRef, ModVersion, ProjectKind, SearchQuery, SearchResult } from '../../../shared/types';
import type { ProjectMeta } from '../resolver';
import { t } from '../../../shared/i18n';
import { getJson, postJson } from '../http';
import type { SourceAdapter } from './types';

const API = 'https://api.modrinth.com/v2';
const API_V3 = 'https://api.modrinth.com/v3';
const LOADERS = new Set(['fabric', 'forge', 'neoforge', 'quilt', 'liteloader', 'rift', 'modloader']);

interface MrHit {
  project_id: string;
  project_type: string;
  slug: string;
  author: string;
  title: string;
  description: string;
  display_categories?: string[];
  categories: string[];
  versions: string[];
  downloads: number;
  icon_url?: string | null;
  date_modified: string;
}

interface MrProject {
  id: string;
  slug: string;
  project_type: string;
  title: string;
  description: string;
  categories: string[];
  loaders: string[];
  game_versions: string[];
  downloads: number;
  icon_url?: string | null;
  updated: string;
}

export interface MrVersion {
  id: string;
  project_id: string;
  name: string;
  version_number: string;
  game_versions: string[];
  loaders: string[];
  date_published: string;
  files: { url: string; filename: string; size: number; primary: boolean; hashes: { sha1?: string; sha512?: string } }[];
  dependencies: { version_id: string | null; project_id: string | null; file_name: string | null; dependency_type: string }[];
}

const kindOf = (t: string): ProjectKind =>
  t === 'mod' ? 'mod' : t === 'modpack' ? 'modpack' : t === 'resourcepack' ? 'resourcepack' : t === 'shader' ? 'shader' : 'other';

const depKind = (t: string): DepKind =>
  t === 'required' ? 'requires' : t === 'incompatible' ? 'conflicts' : t === 'embedded' ? 'embedded' : 'optional';

export interface ModrinthAccount {
  username: string;
  collections: { id: string; name: string; count: number }[];
  /** followed projects can be listed (needs a token) */
  follows: boolean;
}

export class ModrinthSource implements SourceAdapter {
  /** personal access token of the user's Modrinth account, when given */
  token: () => string | undefined = () => undefined;

  private auth(): Record<string, string> {
    const tk = this.token();
    return tk ? { Authorization: tk } : {};
  }

  /** Collections of a Modrinth account: public ones by user name, private ones too with a token. */
  async account(user?: string): Promise<ModrinthAccount> {
    let id = user?.trim();
    let username = id ?? '';
    if (this.token()) {
      const me = await getJson<{ id: string; username: string }>(`${API}/user`, this.auth(), 0);
      id = me.id;
      username = me.username;
    }
    if (!id) throw new Error(t('Укажите имя пользователя или токен Modrinth в настройках'));
    const cols = await getJson<{ id: string; name: string; projects: string[] }[]>(`${API_V3}/user/${encodeURIComponent(id)}/collections`, this.auth(), 60_000);
    return { username, collections: cols.map((c) => ({ id: c.id, name: c.name, count: c.projects.length })), follows: !!this.token() };
  }

  /** Projects of one collection, or the projects the account follows. */
  async listProjects(list: { collection: string } | { follows: true }): Promise<ModProject[]> {
    let ids: string[];
    if ('collection' in list) {
      ids = (await getJson<{ projects: string[] }>(`${API_V3}/collection/${encodeURIComponent(list.collection)}`, this.auth(), 60_000)).projects;
    } else {
      const me = await getJson<{ id: string }>(`${API}/user`, this.auth(), 0);
      ids = (await getJson<MrProject[]>(`${API}/user/${encodeURIComponent(me.id)}/follows`, this.auth(), 0)).map((p) => p.id);
    }
    const out: ModProject[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const batch = await getJson<MrProject[]>(`${API}/projects?ids=${encodeURIComponent(JSON.stringify(ids.slice(i, i + 100)))}`);
      out.push(...batch.map(mrToProject));
    }
    return out;
  }

  async search(q: SearchQuery): Promise<SearchResult> {
    const facets: string[][] = [[`project_type:${q.kind && q.kind !== 'library' && q.kind !== 'other' ? q.kind : 'mod'}`]];
    if (q.compatibleOnly !== false) {
      if (q.ctx.gameVersion) facets.push([`versions:${q.ctx.gameVersion}`]);
      if (q.ctx.loader && (!q.kind || q.kind === 'mod' || q.kind === 'modpack')) {
        facets.push(q.ctx.loader === 'quilt' ? ['categories:quilt', 'categories:fabric'] : [`categories:${q.ctx.loader}`]);
      }
    }
    const params = new URLSearchParams({
      query: q.text,
      facets: JSON.stringify(facets),
      limit: String(q.limit ?? 30),
      offset: String(q.offset ?? 0),
      index: q.text ? 'relevance' : 'downloads',
    });
    const res = await getJson<{ hits: MrHit[]; total_hits: number; offset: number }>(`${API}/search?${params}`);
    return {
      total: res.total_hits,
      offset: res.offset,
      hits: res.hits.map((h) => ({
        ref: { source: 'modrinth', projectId: h.project_id },
        title: h.title,
        summary: h.description,
        author: h.author,
        iconUrl: h.icon_url ?? undefined,
        downloads: h.downloads,
        updated: h.date_modified,
        categories: (h.display_categories ?? h.categories).filter((c) => !LOADERS.has(c)),
        url: `https://modrinth.com/${h.project_type}/${h.slug}`,
        kind: kindOf(h.project_type),
        gameVersions: h.versions,
        loaders: h.categories.filter((c) => LOADERS.has(c)),
      })),
    };
  }

  async versions(ref: ModRef, ctx: GameContext): Promise<ModVersion[]> {
    const params = new URLSearchParams();
    if (ctx.gameVersion) params.set('game_versions', JSON.stringify([ctx.gameVersion]));
    const list = await getJson<MrVersion[]>(`${API}/project/${encodeURIComponent(ref.projectId)}/version?${params}`);
    return this.mapVersions(list);
  }

  /** Maps raw versions, resolving dependencies that only name a version id. */
  async mapVersions(list: MrVersion[]): Promise<ModVersion[]> {
    const orphanIds = [...new Set(list.flatMap((v) => v.dependencies.filter((d) => !d.project_id && d.version_id).map((d) => d.version_id!)))];
    const owner = new Map<string, string>();
    if (orphanIds.length) {
      const found = await getJson<MrVersion[]>(`${API}/versions?ids=${encodeURIComponent(JSON.stringify(orphanIds))}`).catch(() => []);
      for (const v of found) owner.set(v.id, v.project_id);
    }
    return list.map((v) => ({
      ref: { source: 'modrinth' as const, projectId: v.project_id },
      versionId: v.id,
      version: v.version_number,
      name: v.name,
      gameVersions: v.game_versions,
      loaders: v.loaders,
      published: v.date_published,
      files: v.files.map((f) => ({ url: f.url, filename: f.filename, size: f.size, hashes: f.hashes, primary: f.primary })),
      deps: v.dependencies
        .map((d) => {
          const pid = d.project_id ?? (d.version_id ? owner.get(d.version_id) : undefined);
          if (!pid || pid === v.project_id) return null;
          return { ref: { source: 'modrinth' as const, projectId: pid }, kind: depKind(d.dependency_type), versionId: d.version_id ?? undefined };
        })
        .filter((d): d is NonNullable<typeof d> => d !== null),
    }));
  }

  async project(ref: ModRef): Promise<ModProject | null> {
    return mrToProject(await getJson<MrProject>(`${API}/project/${encodeURIComponent(ref.projectId)}`));
  }

  async meta(refs: ModRef[]): Promise<Map<string, ProjectMeta>> {
    const out = new Map<string, ProjectMeta>();
    const ids = [...new Set(refs.map((r) => r.projectId))];
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      const list = await getJson<MrProject[]>(`${API}/projects?ids=${encodeURIComponent(JSON.stringify(batch))}`);
      for (const p of list) out.set(`modrinth:${p.id}`, { title: p.title, iconUrl: p.icon_url ?? undefined });
    }
    return out;
  }

  /** Looks up versions by file hash (used to link .mrpack contents to real projects). */
  async versionsByHash(hashes: string[], algorithm: 'sha1' | 'sha512'): Promise<Map<string, MrVersion>> {
    const out = new Map<string, MrVersion>();
    for (let i = 0; i < hashes.length; i += 200) {
      const res = await postJson<Record<string, MrVersion>>(`${API}/version_files`, { hashes: hashes.slice(i, i + 200), algorithm });
      for (const [h, v] of Object.entries(res)) out.set(h, v);
    }
    return out;
  }

  async gameVersions(): Promise<string[]> {
    const list = await getJson<{ version: string; version_type: string }[]>(`${API}/tag/game_version`, {}, 3_600_000);
    return list.filter((v) => v.version_type === 'release').map((v) => v.version);
  }
}

function mrToProject(p: MrProject): ModProject {
  return {
    ref: { source: 'modrinth', projectId: p.id },
    title: p.title,
    summary: p.description,
    author: '',
    iconUrl: p.icon_url ?? undefined,
    downloads: p.downloads,
    updated: p.updated,
    categories: p.categories,
    url: `https://modrinth.com/${p.project_type}/${p.slug}`,
    kind: kindOf(p.project_type),
    gameVersions: p.game_versions,
    loaders: p.loaders,
  };
}
