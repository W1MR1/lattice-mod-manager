import type { DepDecl, InstalledMod, ModRef, ModVersion, Profile } from '../shared/types';
import type { ProjectMeta, VersionProvider } from '../electron/core/resolver';

export const ref = (id: string): ModRef => ({ source: 'modrinth', projectId: id });

export function ver(id: string, version: string, opts: Partial<ModVersion> & { requires?: string[]; date?: string } = {}): ModVersion {
  const deps: DepDecl[] = [
    ...(opts.requires ?? []).map((r) => {
      const [pid, range] = r.split(' ');
      return { ref: ref(pid), kind: 'requires' as const, range };
    }),
    ...(opts.deps ?? []),
  ];
  return {
    ref: ref(id),
    versionId: `${id}@${version}`,
    version,
    gameVersions: opts.gameVersions ?? ['1.21.1'],
    loaders: opts.loaders ?? ['fabric'],
    published: opts.date ?? `2026-01-${String(10 + Number(version.split('.')[1] ?? 0)).padStart(2, '0')}T00:00:00Z`,
    files: [{ url: `https://cdn.modrinth.com/${id}-${version}.jar`, filename: `${id}-${version}.jar`, hashes: {} }],
    deps,
    provides: opts.provides,
  };
}

export function provider(versions: ModVersion[]): VersionProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async versions(r) {
      calls.push(r.projectId);
      return versions.filter((v) => v.ref.projectId === r.projectId);
    },
    async meta(refs) {
      return new Map<string, ProjectMeta>(refs.map((r) => [`modrinth:${r.projectId}`, { title: r.projectId.toUpperCase() }]));
    },
  };
}

export function installed(v: ModVersion, extra: Partial<InstalledMod> = {}): InstalledMod {
  return {
    key: `modrinth:${v.ref.projectId}`,
    ref: v.ref,
    title: v.ref.projectId.toUpperCase(),
    versionId: v.versionId,
    version: v.version,
    gameVersions: v.gameVersions,
    loaders: v.loaders,
    enabled: true,
    reason: 'explicit',
    requiredBy: [],
    deps: v.deps,
    provides: v.provides,
    files: v.files,
    stagedPath: '',
    installedAt: v.published,
    ...extra,
  };
}

export function profile(mods: InstalledMod[] = [], extra: Partial<Profile> = {}): Profile {
  return {
    id: 'p1',
    gameId: 'g1',
    name: 'test',
    context: { gameDefId: 'minecraft', gameVersion: '1.21.1', loader: 'fabric' },
    mods: Object.fromEntries(mods.map((m) => [m.key, m])),
    rules: [],
    collections: [],
    createdAt: '2026-01-01T00:00:00Z',
    ...extra,
  };
}
