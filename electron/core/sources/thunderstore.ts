// Thunderstore: the community package index is downloaded in chunks, cached on
// disk and searched locally. Dependencies look like "Namespace-Name-1.2.3".
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { GameContext, GameDef, ModProject, ModRef, ModVersion, SearchQuery, SearchResult } from '../../../shared/types';
import type { ProjectMeta } from '../resolver';
import { getMaybeGzipJson, mapPool } from '../http';
import type { SourceAdapter } from './types';
import { isBepInExPack, isThunderstoreMod } from '../games';
import { t } from '../../../shared/i18n';

interface TsVersion {
  version_number: string;
  full_name: string;
  description: string;
  icon: string;
  dependencies: string[];
  download_url: string;
  downloads: number;
  date_created: string;
  file_size: number;
}

interface TsPackage {
  full_name: string;
  owner: string;
  name: string;
  package_url: string;
  date_updated: string;
  rating_score: number;
  is_deprecated: boolean;
  has_nsfw_content: boolean;
  categories: string[];
  versions: TsVersion[];
}

interface Index {
  at: number;
  byName: Map<string, TsPackage>;
  list: TsPackage[];
  /** the community's own BepInEx pack: the loader its mods are started by */
  loader?: string;
}

/**
 * What a package asks for, in this community. Two things the listing itself
 * does not say:
 * - a package shared between communities names the loader of the community it
 *   was written in; here that means this community's loader;
 * - a plugin that names no loader at all still cannot start without one.
 */
export function communityDeps(projectId: string, raw: string[], has: (id: string) => boolean, loader: string | undefined): { projectId: string; version?: string }[] {
  const out = new Map<string, { projectId: string; version?: string }>();
  for (const d of raw.map(parseDependency)) {
    if (!d) continue;
    const here = loader && isBepInExPack(d.projectId) && !has(d.projectId) ? { projectId: loader } : d;
    if (!out.has(here.projectId)) out.set(here.projectId, here);
  }
  if (loader && !isBepInExPack(projectId) && ![...out.keys()].some(isBepInExPack)) out.set(loader, { projectId: loader });
  return [...out.values()];
}

const MEMORY_TTL = 30 * 60_000;
const DISK_TTL = 6 * 3_600_000;
const KEEP_VERSIONS = 25;

/** "BepInEx-BepInExPack-5.4.2100" -> { projectId: "BepInEx-BepInExPack", version: "5.4.2100" } */
export function parseDependency(s: string): { projectId: string; version: string } | null {
  const m = /^(.+)-(\d+\.\d+\.\d+)$/.exec(s);
  return m ? { projectId: m[1], version: m[2] } : null;
}

export class ThunderstoreSource implements SourceAdapter {
  private indexes = new Map<string, Index>();
  private loading = new Map<string, Promise<Index>>();
  private loaders = new Map<string, string | undefined>();

  constructor(
    private cacheDir: () => string,
    private gameDef: (id: string) => GameDef | undefined,
  ) {}

  private community(ctx: GameContext): string {
    const c = this.gameDef(ctx.gameDefId)?.thunderstoreCommunity;
    if (!c) throw new Error(t('Для этой игры нет сообщества Thunderstore'));
    return c;
  }

  async index(community: string): Promise<Index> {
    const mem = this.indexes.get(community);
    if (mem && Date.now() - mem.at < MEMORY_TTL) return mem;
    const pending = this.loading.get(community);
    if (pending) return pending;
    const p = this.load(community).finally(() => this.loading.delete(community));
    this.loading.set(community, p);
    return p;
  }

  private async load(community: string): Promise<Index> {
    const file = path.join(this.cacheDir(), `thunderstore-${community}.json.gz`);
    let list: TsPackage[] | null = null;
    let at = Date.now();
    try {
      const st = await fs.stat(file);
      if (Date.now() - st.mtimeMs < DISK_TTL) {
        list = JSON.parse(gunzipSync(await fs.readFile(file)).toString('utf8'));
        at = st.mtimeMs;
      }
    } catch {
      /* no cache yet */
    }
    if (!list) {
      const chunks = await getMaybeGzipJson<string[]>(`https://thunderstore.io/c/${community}/api/v1/package-listing-index/`);
      const parts = await mapPool(chunks, 4, (u) => getMaybeGzipJson<TsPackage[]>(u));
      list = parts.flat().map(trim);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, gzipSync(Buffer.from(JSON.stringify(list))));
    }
    const idx: Index = { at, list, loader: loaderOf(list), byName: new Map(list.map((p) => [p.full_name, p])) };
    this.loaders.set(community, idx.loader);
    this.indexes.set(community, idx);
    return idx;
  }

  async search(q: SearchQuery): Promise<SearchResult> {
    const idx = await this.index(this.community(q.ctx));
    const text = q.text.trim().toLowerCase();
    const words = text.split(/\s+/).filter(Boolean);
    const scored: { p: TsPackage; s: number }[] = [];
    for (const p of idx.list) {
      if (p.is_deprecated || p.has_nsfw_content || p.versions.length === 0 || !isThunderstoreMod(p.full_name)) continue;
      // modpacks are packages that only depend on other packages
      const pack = p.categories.some((c) => /modpack/i.test(c));
      if ((q.kind === 'modpack') !== pack) continue;
      const latest = p.versions[0];
      const total = p.versions.reduce((a, v) => a + v.downloads, 0);
      let s = Math.log10(total + 10) + p.rating_score / 200;
      if (words.length) {
        const name = p.name.toLowerCase().replace(/_/g, ' ');
        const hay = `${name} ${p.owner.toLowerCase()} ${latest.description.toLowerCase()}`;
        if (!words.every((w) => hay.includes(w))) continue;
        if (name === text) s += 20;
        else if (name.startsWith(text)) s += 10;
        else if (words.every((w) => name.includes(w))) s += 5;
      }
      scored.push({ p, s });
    }
    scored.sort((a, b) => b.s - a.s);
    const offset = q.offset ?? 0;
    const page = scored.slice(offset, offset + (q.limit ?? 30));
    return { total: scored.length, offset, hits: page.map(({ p }) => toProject(p)) };
  }

  async versions(ref: ModRef, ctx: GameContext): Promise<ModVersion[]> {
    const idx = await this.index(this.community(ctx));
    const p = idx.byName.get(ref.projectId);
    if (!p) return [];
    return p.versions.map((v) => ({
      ref,
      versionId: v.full_name,
      version: v.version_number,
      gameVersions: [],
      loaders: [],
      published: v.date_created,
      files: [{ url: v.download_url, filename: `${v.full_name}.zip`, size: v.file_size, hashes: {}, primary: true }],
      deps: communityDeps(ref.projectId, v.dependencies, (id) => idx.byName.has(id), idx.loader).map((d) => ({
        ref: { source: 'thunderstore' as const, projectId: d.projectId },
        kind: 'requires' as const,
        range: d.version ? `>=${d.version}` : undefined,
        name: d.projectId.split('-').slice(1).join('-'),
      })),
    }));
  }

  /**
   * The BepInEx pack of the game's community, from what is already on this
   * computer: asked on every compatibility check, so it never goes to the network.
   */
  async loaderPack(ctx: GameContext): Promise<string | undefined> {
    const community = this.community(ctx);
    if (this.loaders.has(community)) return this.loaders.get(community);
    let loader: string | undefined;
    try {
      loader = loaderOf(JSON.parse(gunzipSync(await fs.readFile(path.join(this.cacheDir(), `thunderstore-${community}.json.gz`))).toString('utf8')));
    } catch {
      return undefined; // no index yet: the next search or plan brings it
    }
    this.loaders.set(community, loader);
    return loader;
  }

  async project(ref: ModRef, ctx: GameContext): Promise<ModProject | null> {
    const idx = await this.index(this.community(ctx));
    const p = idx.byName.get(ref.projectId);
    return p ? toProject(p) : null;
  }

  async meta(refs: ModRef[], ctx: GameContext): Promise<Map<string, ProjectMeta>> {
    const idx = await this.index(this.community(ctx));
    const out = new Map<string, ProjectMeta>();
    for (const r of refs) {
      const p = idx.byName.get(r.projectId);
      if (p) out.set(`thunderstore:${r.projectId}`, { title: p.name.replace(/_/g, ' '), iconUrl: p.versions[0]?.icon, author: p.owner });
    }
    return out;
  }
}

/** The loader of a community: the most downloaded BepInEx pack its index lists. */
function loaderOf(list: TsPackage[]): string | undefined {
  const downloads = (p: TsPackage) => p.versions.reduce((a, v) => a + v.downloads, 0);
  return list.filter((p) => isBepInExPack(p.full_name) && !p.is_deprecated && p.versions.length > 0).sort((a, b) => downloads(b) - downloads(a))[0]?.full_name;
}

function trim(p: TsPackage): TsPackage {
  return {
    full_name: p.full_name,
    owner: p.owner,
    name: p.name,
    package_url: p.package_url,
    date_updated: p.date_updated,
    rating_score: p.rating_score,
    is_deprecated: p.is_deprecated,
    has_nsfw_content: p.has_nsfw_content,
    categories: p.categories,
    versions: p.versions.slice(0, KEEP_VERSIONS).map((v) => ({
      version_number: v.version_number,
      full_name: v.full_name,
      description: v.description,
      icon: v.icon,
      dependencies: v.dependencies,
      download_url: v.download_url,
      downloads: v.downloads,
      date_created: v.date_created,
      file_size: v.file_size,
    })),
  };
}

function toProject(p: TsPackage): ModProject {
  const latest = p.versions[0];
  return {
    ref: { source: 'thunderstore', projectId: p.full_name },
    title: p.name.replace(/_/g, ' '),
    summary: latest?.description ?? '',
    author: p.owner,
    iconUrl: latest?.icon,
    downloads: p.versions.reduce((a, v) => a + v.downloads, 0),
    updated: p.date_updated,
    categories: p.categories,
    url: p.package_url,
    kind: p.categories.some((c) => /modpack/i.test(c)) ? 'modpack' : p.categories.some((c) => /librar/i.test(c)) ? 'library' : 'mod',
  };
}
