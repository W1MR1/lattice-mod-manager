// Collections are lockfiles: exact versions with hashes, order rules and links
// to the collections they build on or cannot be combined with.
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Collection, CollectionLink, CollectionMod, Profile } from '../../shared/types';
import { extractZip, listZip } from './archives';
import { safeName, STAGED_PREFIX } from './installer';
import type { ModrinthSource } from './sources/modrinth';

export function slugId(name: string, salt: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  const h = createHash('sha1').update(salt).digest('hex').slice(0, 6);
  return `${slug || 'collection'}-${h}`;
}

export interface CollectionMeta {
  name: string;
  version: string;
  author: string;
  description: string;
  requires?: CollectionLink[];
  conflicts?: CollectionLink[];
}

export function fromProfile(profile: Profile, meta: CollectionMeta, existing: Collection[]): Collection {
  const mods: CollectionMod[] = Object.values(profile.mods)
    .filter((m) => m.enabled)
    .map((m) => ({
      ref: m.ref,
      title: m.title,
      versionId: m.versionId,
      version: m.version,
      optional: false,
      files: m.files,
      deps: m.deps,
      gameVersions: m.gameVersions,
      loaders: m.loaders,
      choices: m.choices,
    }));
  // Collections already applied to the profile become explicit links.
  const auto: CollectionLink[] = profile.collections
    .map((id) => existing.find((c) => c.id === id))
    .filter((c): c is Collection => !!c)
    .map((c) => ({ collectionId: c.id, name: c.name, range: `^${c.version}` }));
  const requires = [...(meta.requires ?? [])];
  for (const a of auto) if (!requires.some((r) => r.collectionId === a.collectionId)) requires.push(a);
  return {
    schema: 'lattice.collection/1',
    id: slugId(meta.name, `${profile.id}:${Date.now()}`),
    name: meta.name,
    version: meta.version || '1.0.0',
    author: meta.author,
    description: meta.description,
    game: { defId: profile.context.gameDefId, gameVersion: profile.context.gameVersion, loader: profile.context.loader },
    requires,
    conflicts: meta.conflicts ?? [],
    mods,
    rules: profile.rules.filter((r) => profile.mods[r.subject] && profile.mods[r.other]),
    createdAt: new Date().toISOString(),
  };
}

export function parseCollection(text: string): Collection {
  const c = JSON.parse(text) as Collection;
  if (c.schema !== 'lattice.collection/1') throw new Error('Это не файл коллекции Lattice (нет schema lattice.collection/1)');
  if (!c.id || !c.name || !Array.isArray(c.mods) || !c.game?.defId) throw new Error('Файл коллекции повреждён: нет id, name, game или mods');
  c.requires ??= [];
  c.conflicts ??= [];
  c.rules ??= [];
  for (const m of c.mods) {
    if (!m.ref?.source || !m.ref.projectId || !m.versionId) throw new Error(`Мод «${m.title ?? '?'}» в коллекции без ссылки на источник`);
    m.deps ??= [];
    m.files ??= [];
    m.gameVersions ??= [];
    m.loaders ??= [];
  }
  return c;
}

interface MrpackIndex {
  formatVersion: number;
  game: string;
  versionId: string;
  name: string;
  summary?: string;
  files: { path: string; hashes: { sha1: string; sha512: string }; env?: { client?: string; server?: string }; downloads: string[]; fileSize: number }[];
  dependencies: Record<string, string>;
}

const LOADER_KEYS: Record<string, string> = {
  'fabric-loader': 'fabric',
  'quilt-loader': 'quilt',
  forge: 'forge',
  neoforge: 'neoforge',
};

/** Imports a Modrinth modpack (.mrpack). Files are linked back to their Modrinth projects by hash. */
export async function importMrpack(file: string, modrinth: ModrinthSource, stagingRoot: string): Promise<Collection> {
  const names = await listZip(file);
  if (!names.includes('modrinth.index.json')) throw new Error('В архиве нет modrinth.index.json — это не сборка Modrinth');
  const tmp = path.join(stagingRoot, '_import', safeName(path.basename(file)) + '-' + Date.now());
  await extractZip(file, tmp, (n) => (n === 'modrinth.index.json' ? n : null));
  const index = JSON.parse(await fs.readFile(path.join(tmp, 'modrinth.index.json'), 'utf8')) as MrpackIndex;
  if (index.game !== 'minecraft') throw new Error(`Сборка для игры «${index.game}» не поддерживается`);

  const gameVersion = index.dependencies.minecraft;
  const loaderKey = Object.keys(index.dependencies).find((k) => LOADER_KEYS[k]);
  const loader = loaderKey ? LOADER_KEYS[loaderKey] : undefined;
  const id = slugId(index.name, `${index.name}@${index.versionId}`);

  const clientFiles = index.files.filter((f) => f.env?.client !== 'unsupported');
  const byHash = await modrinth.versionsByHash(
    clientFiles.map((f) => f.hashes.sha1),
    'sha1',
  );
  const mapped = await modrinth.mapVersions([...byHash.values()]);
  const versionById = new Map(mapped.map((v) => [v.versionId, v]));

  const mods: CollectionMod[] = [];
  for (const f of clientFiles) {
    const raw = byHash.get(f.hashes.sha1);
    const v = raw ? versionById.get(raw.id) : undefined;
    const fileEntry = {
      url: f.downloads[0],
      filename: path.posix.basename(f.path),
      size: f.fileSize,
      hashes: { sha1: f.hashes.sha1, sha512: f.hashes.sha512 },
      primary: true,
      targetPath: f.path,
    };
    if (v) {
      mods.push({
        ref: v.ref,
        title: raw!.name || fileEntry.filename,
        versionId: v.versionId,
        version: v.version,
        optional: f.env?.client === 'optional',
        files: [fileEntry],
        deps: v.deps,
        gameVersions: v.gameVersions,
        loaders: v.loaders,
      });
    } else {
      mods.push({
        ref: { source: 'local', projectId: `${id}/${f.path}` },
        title: fileEntry.filename,
        versionId: f.hashes.sha1,
        version: '—',
        optional: f.env?.client === 'optional',
        files: [fileEntry],
        deps: [],
        gameVersions: [],
        loaders: [],
      });
    }
  }
  // Project titles for nicer names.
  const meta = await modrinth.meta(mods.filter((m) => m.ref.source === 'modrinth').map((m) => m.ref)).catch(() => new Map());
  for (const m of mods) {
    const t = meta.get(`${m.ref.source}:${m.ref.projectId}`)?.title;
    if (t) m.title = t;
  }

  // overrides/ and client-overrides/ become one staged pseudo-mod.
  const overrides = names.filter((n) => /^(client-)?overrides\/.+[^/]$/.test(n));
  if (overrides.length) {
    const dir = path.join(stagingRoot, '_collections', safeName(id), 'overrides');
    await fs.rm(dir, { recursive: true, force: true });
    await extractZip(file, dir, (n) => {
      const m = /^(?:client-)?overrides\/(.+)$/.exec(n);
      return m ? m[1] : null;
    });
    await fs.writeFile(path.join(dir, '.lattice-complete'), new Date().toISOString());
    mods.push({
      ref: { source: 'local', projectId: `${id}/overrides` },
      title: `${index.name}: настройки сборки`,
      versionId: index.versionId,
      version: index.versionId,
      optional: false,
      files: [{ url: STAGED_PREFIX + dir, filename: 'overrides', hashes: {} }],
      deps: [],
      gameVersions: [],
      loaders: [],
    });
  }
  await fs.rm(tmp, { recursive: true, force: true });

  return {
    schema: 'lattice.collection/1',
    id,
    name: index.name,
    version: index.versionId,
    author: 'Modrinth',
    description: index.summary ?? '',
    game: { defId: 'minecraft', gameVersion, loader },
    requires: [],
    conflicts: [],
    mods,
    rules: [],
    createdAt: new Date().toISOString(),
    importedFrom: path.basename(file),
  };
}

/** The collection plus every collection it builds on, dependencies first. */
export function collectionClosure(id: string, all: Collection[]): { order: Collection[]; missing: CollectionLink[] } {
  const byId = new Map(all.map((c) => [c.id, c]));
  const order: Collection[] = [];
  const missing: CollectionLink[] = [];
  const seen = new Set<string>();
  const visit = (cid: string, link?: CollectionLink) => {
    if (seen.has(cid)) return;
    seen.add(cid);
    const c = byId.get(cid);
    if (!c) {
      if (link) missing.push(link);
      return;
    }
    for (const r of c.requires) visit(r.collectionId, r);
    order.push(c);
  };
  visit(id);
  return { order, missing };
}
