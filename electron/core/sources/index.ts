// One entry point over all sources; also the VersionProvider the resolver uses.
import type { GameContext, GameDef, ModProject, ModRef, ModVersion, SearchQuery, SearchResult, SourceId } from '../../../shared/types';
import { keyOf } from '../../../shared/types';
import type { ProjectMeta, VersionProvider } from '../resolver';
import { GithubSource } from './github';
import { ModrinthSource } from './modrinth';
import { NexusSource } from './nexus';
import { ThunderstoreSource } from './thunderstore';
import type { SourceAdapter } from './types';

export interface LocalEntry {
  title: string;
  author?: string;
  versions: ModVersion[];
}

export class Sources {
  readonly modrinth = new ModrinthSource();
  readonly thunderstore: ThunderstoreSource;
  readonly github: GithubSource;
  readonly nexus: NexusSource;

  constructor(
    cacheDir: () => string,
    gameDef: (id: string) => GameDef | undefined,
    githubToken: () => string | undefined,
    private local: () => Record<string, LocalEntry>,
    nexusKey: () => string | undefined = () => undefined,
  ) {
    this.thunderstore = new ThunderstoreSource(cacheDir, gameDef);
    this.github = new GithubSource(githubToken);
    this.nexus = new NexusSource(nexusKey, (id) => gameDef(id)?.nexusDomain);
  }

  private adapter(source: SourceId): SourceAdapter | null {
    if (source === 'modrinth') return this.modrinth;
    if (source === 'thunderstore') return this.thunderstore;
    if (source === 'github') return this.github;
    if (source === 'nexus') return this.nexus;
    return null;
  }

  search(q: SearchQuery): Promise<SearchResult> {
    const a = this.adapter(q.source);
    if (!a) return Promise.resolve({ hits: [], total: 0, offset: 0 });
    return a.search(q);
  }

  async project(ref: ModRef, ctx: GameContext): Promise<ModProject | null> {
    const a = this.adapter(ref.source);
    if (a) return a.project(ref, ctx);
    const l = this.local()[keyOf(ref)];
    return l
      ? { ref, title: l.title, summary: 'Локальный файл', author: l.author ?? 'вы', downloads: 0, updated: l.versions[0]?.published ?? '', categories: [], url: '', kind: 'mod' }
      : null;
  }

  /**
   * A provider for one resolution. `overlay` holds versions already known
   * (e.g. the exact versions locked in a collection) so no lookup is needed.
   */
  provider(ctx: GameContext, overlay: Map<string, ModVersion[]> = new Map(), overlayMeta: Map<string, ProjectMeta> = new Map()): VersionProvider {
    return {
      versions: async (ref) => {
        const k = keyOf(ref);
        const known = overlay.get(k) ?? [];
        if (ref.source === 'local') return [...known, ...(this.local()[k]?.versions ?? [])];
        const a = this.adapter(ref.source)!;
        try {
          const remote = await a.versions(ref, ctx);
          return [...known, ...remote.filter((v) => !known.some((x) => x.versionId === v.versionId))];
        } catch (e) {
          if (known.length) return known; // offline: the lock is enough
          throw e;
        }
      },
      meta: async (refs) => {
        const out = new Map<string, ProjectMeta>();
        const bySource = new Map<SourceId, ModRef[]>();
        for (const r of refs) {
          const k = keyOf(r);
          const m = overlayMeta.get(k);
          if (m) out.set(k, m);
          else if (r.source === 'local') {
            const l = this.local()[k];
            if (l) out.set(k, { title: l.title, author: l.author });
          } else bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);
        }
        await Promise.all(
          [...bySource].map(async ([s, list]) => {
            const res = await this.adapter(s)!.meta(list, ctx).catch(() => new Map<string, ProjectMeta>());
            for (const [k, v] of res) out.set(k, v);
          }),
        );
        return out;
      },
    };
  }
}
