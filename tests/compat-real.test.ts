// A real modpack as the regression case: "Zombie Apocalypse 1.1" from Modrinth
// (107 mods, Minecraft 1.20.1, Fabric). The pack starts and plays; before 0.4.0
// Lattice showed it with 10 errors and a score of 0, every one of them a false
// alarm. tests/data/zombie-pack.json holds what the catalogue says about each
// mod and what each jar declares — no mod files.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCompatibility, type DepInfo } from '../electron/core/compat';
import { jarView, type JarMeta } from '../electron/core/jarmeta';
import { computeOrder } from '../electron/core/loadorder';
import { refOf, type DepDecl, type GameContext, type InstalledMod, type Profile } from '../shared/types';

interface PackMod {
  key: string;
  title: string;
  version: string;
  gameVersions: string[];
  loaders: string[];
  reason: InstalledMod['reason'];
  deps: DepDecl[];
}
const pack = JSON.parse(readFileSync(path.join(__dirname, 'data', 'zombie-pack.json'), 'utf8')) as {
  context: GameContext;
  mods: PackMod[];
  jars: Record<string, JarMeta>;
  known: Record<string, DepInfo>;
};

function profileOf(ctx: GameContext): Profile {
  const mods: Record<string, InstalledMod> = {};
  for (const m of pack.mods) {
    mods[m.key] = { ...m, ref: refOf(m.key), versionId: m.version, enabled: true, requiredBy: [], files: [], stagedPath: '', installedAt: '2026-11-01T00:00:00Z' };
  }
  return { id: 'p', gameId: 'g', name: 'Zombie', context: ctx, mods, rules: [], collections: [], createdAt: '2026-11-01T00:00:00Z' };
}
const jars = new Map(Object.entries(pack.jars));
const known = new Map(Object.entries(pack.known));

describe('a real 107-mod Fabric pack', () => {
  it('has no errors: what jars ask other loaders for and what the catalogue lists for them is not held against it', () => {
    const r = checkCompatibility(profileOf(pack.context), [], [], undefined, jars, known);
    expect(r.issues.filter((i) => i.severity === 'error').map((i) => i.message)).toEqual([]);
    expect(r.score).toBe(100);
    // the catalogue's loader-specific links are still told, quietly and by name
    const quiet = r.issues.filter((i) => i.code === 'catalog-dep');
    expect(quiet.length).toBeGreaterThan(0);
    expect(quiet.every((i) => i.severity === 'info')).toBe(true);
    expect(quiet.some((i) => i.message.includes('Timeless and Classics Zero'))).toBe(true);
    expect(quiet.some((i) => /SzzJttH8|qvIfYCYJ/.test(i.message))).toBe(false);
    expect(r.names?.['modrinth:SzzJttH8']).toMatch(/TaCZ/);
  });

  it('stays free of errors on a first look, before the catalogue has answered', () => {
    const r = checkCompatibility(profileOf(pack.context), [], [], undefined, jars);
    expect(r.errors).toBe(0);
  });

  it('mods that point at each other do not make a "circular load order"', () => {
    const p = profileOf(pack.context);
    const { order, cycles } = computeOrder(Object.values(p.mods), []);
    expect(cycles).toEqual([]);
    expect(order).toHaveLength(pack.mods.length);
    // a rule that contradicts another one still is a problem worth telling
    const [a, b] = order;
    const ruled = computeOrder(Object.values(p.mods), [
      { subject: a, kind: 'before', other: b },
      { subject: b, kind: 'before', other: a },
    ]);
    expect(ruled.cycles).toHaveLength(1);
    expect(ruled.order).toHaveLength(pack.mods.length);
  });

  it('the same jars on Quilt really need what they ask Quilt for', () => {
    const structory = pack.mods.find((m) => m.title === 'Structory')!;
    expect(jarView(jars.get(structory.key), 'fabric').depends.map((d) => d.id)).not.toContain('quilt_resource_loader');
    expect(jarView(jars.get(structory.key), 'quilt').depends.map((d) => d.id)).toContain('quilt_resource_loader');
    const r = checkCompatibility(profileOf({ ...pack.context, loader: 'quilt' }), [], [], undefined, jars, known);
    expect(r.issues.some((i) => i.code === 'jar-dependency' && i.subject === structory.key)).toBe(true);
  });

  it('a jar made only for Forge is an error on Fabric, and nothing else is asked of it', () => {
    const p = profileOf(pack.context);
    const any = pack.mods[0];
    const forgeOnly = new Map(jars);
    forgeOnly.set(any.key, { ids: ['x'], versions: {}, depends: [{ id: 'forge_only_lib' }], breaks: [], loaders: ['forge', 'neoforge'], by: { forge: { ids: ['x'], versions: {}, depends: [{ id: 'forge_only_lib' }], breaks: [] } } });
    const mine = checkCompatibility(p, [], [], undefined, forgeOnly, known).issues.filter((i) => i.subject === any.key && i.severity === 'error');
    expect(mine.map((i) => i.code)).toEqual(['incompatible-loader']);
  });
});
