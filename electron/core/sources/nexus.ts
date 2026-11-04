// Nexus Mods through its official APIs. Search, files and mod requirements come
// from the public GraphQL API; downloads use the v1 API with the user's own key.
// Free accounts get files only through "Mod Manager Download" (nxm:// links),
// and Nexus' own server-side speed limit for them is respected, not bypassed.
import type { DepDecl, GameContext, ModProject, ModRef, ModVersion, SearchQuery, SearchResult } from '../../../shared/types';
import type { ProjectMeta } from '../resolver';
import { HttpError } from '../http';
import { USER_AGENT } from '../downloader';
import type { SourceAdapter } from './types';
import { APP_NAME, APP_VERSION } from '../app-info';
import { t } from '../../../shared/i18n';

const GQL = 'https://api.nexusmods.com/v2/graphql';
const V1 = 'https://api.nexusmods.com/v1';
const HIDDEN = new Set(['OLD_VERSION', 'ARCHIVED', 'REMOVED', 'DELETED']);

export interface NxmLink {
  domain: string;
  modId: number;
  fileId: number;
  key?: string;
  expires?: number;
}

/** nxm://skyrimspecialedition/mods/12604/files/35407?key=…&expires=…&user_id=… */
export function parseNxm(url: string): NxmLink | null {
  const m = /^nxm:\/\/([a-z0-9]+)\/mods\/(\d+)\/files\/(\d+)(?:\?(.*))?$/i.exec(url.trim());
  if (!m) return null;
  const q = new URLSearchParams(m[4] ?? '');
  return {
    domain: m[1].toLowerCase(),
    modId: Number(m[2]),
    fileId: Number(m[3]),
    key: q.get('key') ?? undefined,
    expires: q.get('expires') ? Number(q.get('expires')) : undefined,
  };
}

/** nexus://<domain>/<modId>/<fileId> — how Lattice stores a Nexus file before a link is issued. */
export function parseNexusUrl(url: string): { domain: string; modId: number; fileId: number } | null {
  const m = /^nexus:\/\/([a-z0-9]+)\/(\d+)\/(\d+)$/i.exec(url);
  return m ? { domain: m[1].toLowerCase(), modId: Number(m[2]), fileId: Number(m[3]) } : null;
}

interface GqlMod {
  modId: number;
  gameId: number;
  name: string;
  summary?: string;
  author?: string;
  downloads?: number;
  pictureUrl?: string;
  thumbnailUrl?: string;
  updatedAt?: string;
  version?: string;
  modRequirements?: { nexusRequirements: { nodes: { modId: string; gameId: string; modName: string; externalRequirement: boolean }[] } };
}

interface GqlFile {
  fileId: number;
  name: string;
  version: string;
  category: string;
  sizeInBytes: string;
  date: number;
  uri: string;
  primary: number;
}

export class NexusSource implements SourceAdapter {
  constructor(
    private apiKey: () => string | undefined,
    private domainOf: (gameDefId: string) => string | undefined,
  ) {}

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(GQL, {
      method: 'POST',
      headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/json', 'Application-Name': APP_NAME, 'Application-Version': APP_VERSION },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new HttpError(res.status, `Nexus: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(`Nexus: ${body.errors[0].message}`);
    return body.data as T;
  }

  private async v1<T>(pathname: string): Promise<T> {
    const key = this.apiKey();
    if (!key) throw new Error(t('Добавьте личный API-ключ Nexus в настройках, чтобы скачивать оттуда файлы'));
    const res = await fetch(`${V1}${pathname}`, {
      headers: { apikey: key, 'User-Agent': USER_AGENT, 'Application-Name': APP_NAME, 'Application-Version': APP_VERSION, Accept: 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpError(res.status, `Nexus: ${res.status} ${text.slice(0, 160)}`);
    }
    return (await res.json()) as T;
  }

  private domain(ctx: GameContext): string {
    const d = this.domainOf(ctx.gameDefId);
    if (!d) throw new Error(t('Для этой игры Nexus Mods не подключён'));
    return d;
  }

  async search(q: SearchQuery): Promise<SearchResult> {
    if (q.kind === 'modpack') return this.collections(q);
    const domain = this.domain(q.ctx);
    const filter: Record<string, unknown> = { gameDomainName: [{ value: domain }], adultContent: [{ value: false }] };
    if (q.text.trim()) filter.name = [{ value: q.text.trim(), op: 'WILDCARD' }];
    const data = await this.gql<{ mods: { totalCount: number; nodes: GqlMod[] } }>(
      `query($filter: ModsFilter, $sort: [ModsSort!], $offset: Int, $count: Int) {
        mods(filter: $filter, sort: $sort, offset: $offset, count: $count) {
          totalCount nodes { modId gameId name summary author downloads thumbnailUrl pictureUrl updatedAt }
        }
      }`,
      {
        filter,
        // among name matches the most downloaded is almost always the one meant
        sort: [{ downloads: { direction: 'DESC' } }],
        offset: q.offset ?? 0,
        count: q.limit ?? 30,
      },
    );
    return { total: data.mods.totalCount, offset: q.offset ?? 0, hits: data.mods.nodes.map((m) => toProject(domain, m)) };
  }

  private async mod(domain: string, modId: number): Promise<GqlMod | null> {
    const data = await this.gql<{ legacyModsByDomain: { nodes: GqlMod[] } }>(
      `query($ids: [CompositeDomainWithIdInput!]!) {
        legacyModsByDomain(ids: $ids) { nodes {
          modId gameId name summary author downloads thumbnailUrl pictureUrl updatedAt version
          modRequirements { nexusRequirements { nodes { modId gameId modName externalRequirement } } }
        } }
      }`,
      { ids: [{ gameDomain: domain, modId }] },
    );
    return data.legacyModsByDomain.nodes[0] ?? null;
  }

  /** Nexus Collections of the game: curated mod lists, offered as modpacks. */
  async collections(q: SearchQuery): Promise<SearchResult> {
    const domain = this.domain(q.ctx);
    const filter: Record<string, unknown> = { gameDomain: [{ value: domain, op: 'EQUALS' }], adultContent: [{ value: false, op: 'EQUALS' }] };
    if (q.text.trim()) filter.name = [{ value: q.text.trim(), op: 'WILDCARD' }];
    const data = await this.gql<{ collectionsV2: { totalCount: number; nodes: GqlCollection[] } }>(
      `query($f: CollectionsSearchFilter, $s: [CollectionsSearchSort!], $offset: Int, $count: Int) {
        collectionsV2(filter: $f, sort: $s, offset: $offset, count: $count) {
          totalCount nodes { slug name summary endorsements totalDownloads updatedAt tileImage { url } user { name } latestPublishedRevision { revisionNumber modCount totalSize } }
        }
      }`,
      { f: filter, s: [{ endorsements: { direction: 'DESC' } }], offset: q.offset ?? 0, count: q.limit ?? 30 },
    );
    return { total: data.collectionsV2.totalCount, offset: q.offset ?? 0, hits: data.collectionsV2.nodes.map((c) => collectionToProject(domain, c)) };
  }

  /** The mods of a collection's latest published revision. */
  async collectionMods(slug: string): Promise<NexusCollectionContent> {
    const data = await this.gql<{ collection: GqlCollection & { game: { domainName: string } }; collectionRevision: { revisionNumber: number; gameVersions?: { reference: string }[]; modFiles: GqlCollectionFile[] } }>(
      `query($slug: String!) {
        collection(slug: $slug, viewAdultContent: true) { slug name summary user { name } game { domainName } }
        collectionRevision(slug: $slug, viewAdultContent: true) {
          revisionNumber gameVersions { reference }
          modFiles { fileId optional file { fileId modId name version sizeInBytes uri mod { modId name author } } }
        }
      }`,
      { slug },
    );
    return {
      slug,
      name: data.collection.name,
      summary: data.collection.summary ?? '',
      author: data.collection.user?.name ?? '',
      domain: data.collection.game.domainName,
      revision: data.collectionRevision.revisionNumber,
      gameVersion: data.collectionRevision.gameVersions?.[0]?.reference,
      files: data.collectionRevision.modFiles
        .filter((m) => m.file)
        .map((m) => ({
          modId: m.file.modId,
          fileId: m.fileId,
          version: m.file.version,
          fileName: m.file.name,
          modName: m.file.mod?.name ?? m.file.name,
          author: m.file.mod?.author,
          uri: m.file.uri,
          size: Number(m.file.sizeInBytes) || undefined,
          optional: !!m.optional,
        })),
    };
  }

  /** Requirements of many mods in few requests (50 per request). */
  async requirements(domain: string, modIds: number[]): Promise<Map<number, DepDecl[]>> {
    const out = new Map<number, DepDecl[]>();
    const ids = [...new Set(modIds)];
    for (let i = 0; i < ids.length; i += 50) {
      const data = await this.gql<{ legacyModsByDomain: { nodes: GqlMod[] } }>(
        `query($ids: [CompositeDomainWithIdInput!]!) {
          legacyModsByDomain(ids: $ids) { nodes { modId gameId name modRequirements { nexusRequirements { nodes { modId gameId modName externalRequirement } } } } }
        }`,
        { ids: ids.slice(i, i + 50).map((modId) => ({ gameDomain: domain, modId })) },
      );
      for (const m of data.legacyModsByDomain.nodes) {
        out.set(
          m.modId,
          (m.modRequirements?.nexusRequirements.nodes ?? [])
            .filter((r) => !r.externalRequirement && String(r.gameId) === String(m.gameId) && r.modId)
            .map((r) => ({ ref: { source: 'nexus' as const, projectId: `${domain}/${r.modId}` }, kind: 'requires' as const, name: r.modName })),
        );
      }
    }
    return out;
  }

  async versions(ref: ModRef): Promise<ModVersion[]> {
    const [domain, id] = ref.projectId.split('/');
    const mod = await this.mod(domain, Number(id));
    if (!mod) return [];
    const data = await this.gql<{ modFiles: GqlFile[] }>(
      `query($modId: ID!, $gameId: ID!) { modFiles(modId: $modId, gameId: $gameId) { fileId name version category sizeInBytes date uri primary } }`,
      { modId: String(mod.modId), gameId: String(mod.gameId) },
    );
    const deps: DepDecl[] = (mod.modRequirements?.nexusRequirements.nodes ?? [])
      .filter((r) => !r.externalRequirement && String(r.gameId) === String(mod.gameId) && r.modId)
      .map((r) => ({ ref: { source: 'nexus' as const, projectId: `${domain}/${r.modId}` }, kind: 'requires' as const, name: r.modName }));
    return data.modFiles
      .filter((f) => !HIDDEN.has(f.category))
      .map((f) => ({
        ref,
        versionId: String(f.fileId),
        version: f.version || f.name,
        name: f.name,
        gameVersions: [],
        loaders: [],
        published: new Date(f.date * 1000).toISOString(),
        files: [{ url: `nexus://${domain}/${mod.modId}/${f.fileId}`, filename: f.uri, size: Number(f.sizeInBytes) || undefined, hashes: {}, primary: true }],
        deps,
        // only main files are picked automatically; patches and optional files are chosen by hand
        optional: f.category !== 'MAIN',
      }));
  }

  async project(ref: ModRef): Promise<ModProject | null> {
    const [domain, id] = ref.projectId.split('/');
    const mod = await this.mod(domain, Number(id));
    return mod ? toProject(domain, mod) : null;
  }

  async meta(refs: ModRef[]): Promise<Map<string, ProjectMeta>> {
    const out = new Map<string, ProjectMeta>();
    if (refs.length === 0) return out;
    const ids = refs.map((r) => {
      const [gameDomain, modId] = r.projectId.split('/');
      return { gameDomain, modId: Number(modId) };
    });
    const data = await this.gql<{ legacyModsByDomain: { nodes: (GqlMod & { game?: { domainName: string } })[] } }>(
      `query($ids: [CompositeDomainWithIdInput!]!) { legacyModsByDomain(ids: $ids) { nodes { modId name author thumbnailUrl game { domainName } } } }`,
      { ids },
    );
    for (const m of data.legacyModsByDomain.nodes) {
      out.set(`nexus:${m.game?.domainName ?? ids[0].gameDomain}/${m.modId}`, { title: m.name, author: m.author, iconUrl: m.thumbnailUrl });
    }
    return out;
  }

  /** A CDN link for one file. Free accounts must pass the key from an nxm:// link. */
  async downloadLink(domain: string, modId: number, fileId: number, nxm?: { key?: string; expires?: number }): Promise<string> {
    const q = nxm?.key && nxm.expires ? `?key=${encodeURIComponent(nxm.key)}&expires=${nxm.expires}` : '';
    try {
      const links = await this.v1<{ URI: string; short_name: string }[]>(`/games/${domain}/mods/${modId}/files/${fileId}/download_link.json${q}`);
      if (!links[0]?.URI) throw new Error(t('Nexus не вернул ссылку на файл'));
      return links[0].URI;
    } catch (e) {
      if (e instanceof HttpError && e.status === 403 && !q) {
        throw new Error(
          t('Без Premium Nexus выдаёт файлы только через кнопку «Mod Manager Download» на сайте. Откройте https://www.nexusmods.com/{0}/mods/{1}?tab=files и нажмите её — ссылка nxm:// откроется в Lattice.', domain, modId),
        );
      }
      throw e;
    }
  }

  async validateKey(key: string): Promise<{ name: string; premium: boolean }> {
    const res = await fetch(`${V1}/users/validate.json`, {
      headers: { apikey: key, 'User-Agent': USER_AGENT, 'Application-Name': APP_NAME, 'Application-Version': APP_VERSION },
    });
    if (!res.ok) throw new Error(res.status === 401 ? t('Nexus не принял ключ') : `Nexus: ${res.status}`);
    const u = (await res.json()) as { name: string; is_premium: boolean };
    return { name: u.name, premium: !!u.is_premium };
  }
}

interface GqlCollection {
  slug: string;
  name: string;
  summary?: string;
  endorsements?: number;
  totalDownloads?: number;
  updatedAt?: string;
  tileImage?: { url: string } | null;
  user?: { name: string };
  latestPublishedRevision?: { revisionNumber: number; modCount: number; totalSize: string } | null;
}

interface GqlCollectionFile {
  fileId: number;
  optional: boolean;
  file: { fileId: number; modId: number; name: string; version: string; sizeInBytes?: string; uri: string; mod?: { modId: number; name: string; author?: string } };
}

export interface NexusCollectionContent {
  slug: string;
  name: string;
  summary: string;
  author: string;
  domain: string;
  revision: number;
  gameVersion?: string;
  files: { modId: number; fileId: number; version: string; fileName: string; modName: string; author?: string; uri: string; size?: number; optional: boolean }[];
}

function collectionToProject(domain: string, c: GqlCollection): ModProject {
  const rev = c.latestPublishedRevision;
  return {
    ref: { source: 'nexus', projectId: `collection/${c.slug}` },
    title: c.name,
    summary: [rev ? t('{0} модов', rev.modCount) : '', c.summary ?? ''].filter(Boolean).join(' · '),
    author: c.user?.name ?? '',
    iconUrl: c.tileImage?.url,
    downloads: c.totalDownloads ?? 0,
    updated: c.updatedAt ?? '',
    categories: [],
    url: `https://www.nexusmods.com/games/${domain}/collections/${c.slug}`,
    kind: 'modpack',
  };
}

function toProject(domain: string, m: GqlMod): ModProject {
  return {
    ref: { source: 'nexus', projectId: `${domain}/${m.modId}` },
    title: m.name,
    summary: m.summary ?? '',
    author: m.author ?? '',
    iconUrl: m.thumbnailUrl ?? m.pictureUrl,
    downloads: m.downloads ?? 0,
    updated: m.updatedAt ?? '',
    categories: [],
    url: `https://www.nexusmods.com/${domain}/mods/${m.modId}`,
    kind: 'mod',
  };
}
