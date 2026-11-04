// GitHub Releases. A release may ship a `lattice.json` asset that declares
// dependencies and supported game versions; without it the release has no links.
import type { DepDecl, GameContext, ModFile, ModProject, ModRef, ModVersion, SearchQuery, SearchResult, SourceId } from '../../../shared/types';
import type { ProjectMeta } from '../resolver';
import { getJson } from '../http';
import type { SourceAdapter } from './types';
import { GAME_DEFS, gameDef } from '../games';

const API = 'https://api.github.com';

interface GhRepo {
  full_name: string;
  name: string;
  description: string | null;
  owner: { login: string; avatar_url: string };
  stargazers_count: number;
  pushed_at: string;
  html_url: string;
  topics?: string[];
}

interface GhRelease {
  id: number;
  tag_name: string;
  name: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  assets: { name: string; browser_download_url: string; size: number; digest?: string | null }[];
}

/** Optional manifest attached to a release as `lattice.json`. */
export interface LatticeManifest {
  gameVersions?: string[];
  loaders?: string[];
  provides?: string[];
  dependencies?: { source: SourceId; id: string; kind?: DepDecl['kind']; range?: string; name?: string }[];
}

const ARCHIVE = /\.(zip|7z|jar|rar|dll|pak|esp|esm|esl|ba2|bsa)$/i;
const NOT_PRIMARY = /(sources|javadoc|dev|debug|symbols|pdb)/i;
const OTHER_OS = /(macos|darwin|osx|linux|aarch64)/i;

/** Requirements known for curated repositories that ship no lattice.json. */
function curatedRequires(repo: string): string[] {
  for (const d of GAME_DEFS) for (const f of d.github?.featured ?? []) if (f.repo.toLowerCase() === repo.toLowerCase()) return f.requires ?? [];
  return [];
}

/** A search limited to one game: every hit must also mention the game. */
export function githubQuery(text: string, keywords: string | undefined): string {
  const words = [text.trim() || 'mod', keywords ?? ''].filter(Boolean).join(' ');
  return `${words} in:name,description,topics`;
}

export class GithubSource implements SourceAdapter {
  constructor(private token: () => string | undefined) {}

  private headers(): Record<string, string> {
    const t = this.token();
    return { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
  }

  async search(q: SearchQuery): Promise<SearchResult> {
    const direct = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(q.text.trim());
    if (direct) {
      const repo = await getJson<GhRepo>(`${API}/repos/${direct[1]}`, this.headers()).catch(() => null);
      if (repo) return { total: 1, offset: 0, hits: [toProject(repo)] };
    }
    const game = gameDef(q.ctx.gameDefId)?.github;
    // nothing typed: the curated list for this game, when there is one
    if (!q.text.trim() && game?.featured?.length && !q.offset) {
      const repos = await Promise.all(game.featured.map((f) => getJson<GhRepo>(`${API}/repos/${f.repo}`, this.headers(), 3_600_000).catch(() => null)));
      const hits = repos.filter((r): r is GhRepo => !!r).map(toProject);
      return { total: hits.length, offset: 0, hits };
    }
    const page = Math.floor((q.offset ?? 0) / 20) + 1;
    const res = await getJson<{ total_count: number; items: GhRepo[] }>(
      `${API}/search/repositories?q=${encodeURIComponent(githubQuery(q.text, game?.keywords))}&sort=stars&per_page=20&page=${page}`,
      this.headers(),
    );
    return { total: Math.min(res.total_count, 1000), offset: (page - 1) * 20, hits: res.items.map(toProject) };
  }

  async versions(ref: ModRef, _ctx: GameContext): Promise<ModVersion[]> {
    const releases = await getJson<GhRelease[]>(`${API}/repos/${ref.projectId}/releases?per_page=30`, this.headers());
    const out: ModVersion[] = [];
    for (const r of releases) {
      if (r.draft) continue;
      const manifestAsset = r.assets.find((a) => a.name.toLowerCase() === 'lattice.json');
      let manifest: LatticeManifest = {};
      if (manifestAsset) manifest = await getJson<LatticeManifest>(manifestAsset.browser_download_url).catch(() => ({}));
      const all = r.assets.filter((a) => ARCHIVE.test(a.name));
      if (all.length === 0) continue;
      // builds for other systems only when nothing else is attached
      const candidates = all.filter((a) => !OTHER_OS.test(a.name)).length ? all.filter((a) => !OTHER_OS.test(a.name)) : all;
      const primary = candidates.find((a) => !NOT_PRIMARY.test(a.name)) ?? candidates[0];
      const files: ModFile[] = [primary].map((a) => ({
        url: a.browser_download_url,
        filename: a.name,
        size: a.size,
        hashes: a.digest?.startsWith('sha256:') ? { sha256: a.digest.slice(7) } : {},
        primary: true,
      }));
      out.push({
        ref,
        versionId: String(r.id),
        version: r.tag_name.replace(/^v/i, ''),
        name: r.name ?? r.tag_name,
        gameVersions: manifest.gameVersions ?? [],
        loaders: manifest.loaders ?? [],
        published: r.published_at,
        files,
        provides: manifest.provides,
        deps: manifest.dependencies
          ? manifest.dependencies.map((d) => ({ ref: { source: d.source, projectId: d.id }, kind: d.kind ?? 'requires', range: d.range, name: d.name }))
          : curatedRequires(ref.projectId).map((repo) => ({ ref: { source: 'github' as const, projectId: repo }, kind: 'requires' as const, name: repo.split('/')[1] })),
      });
    }
    return out;
  }

  async project(ref: ModRef): Promise<ModProject | null> {
    const repo = await getJson<GhRepo>(`${API}/repos/${ref.projectId}`, this.headers());
    return toProject(repo);
  }

  async meta(refs: ModRef[]): Promise<Map<string, ProjectMeta>> {
    const out = new Map<string, ProjectMeta>();
    for (const r of refs) {
      const [owner, name] = r.projectId.split('/');
      out.set(`github:${r.projectId}`, { title: name, author: owner, iconUrl: `https://github.com/${owner}.png?size=64` });
    }
    return out;
  }
}

function toProject(r: GhRepo): ModProject {
  return {
    ref: { source: 'github', projectId: r.full_name },
    title: r.name,
    summary: r.description ?? '',
    author: r.owner.login,
    iconUrl: r.owner.avatar_url,
    downloads: r.stargazers_count,
    updated: r.pushed_at,
    categories: r.topics?.slice(0, 4) ?? [],
    url: r.html_url,
    kind: 'mod',
  };
}
