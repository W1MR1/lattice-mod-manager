import { describe, expect, it } from 'vitest';
import { checkCompatibility } from '../electron/core/compat';
import { computeOrder } from '../electron/core/loadorder';
import { collectOrphans } from '../electron/core/service';
import type { Collection } from '../shared/types';
import { installed, profile, ref, ver } from './fixtures';

const coll = (id: string, extra: Partial<Collection> = {}): Collection => ({
  schema: 'lattice.collection/1',
  id,
  name: id.toUpperCase(),
  version: '1.0.0',
  author: 't',
  description: '',
  game: { defId: 'minecraft' },
  requires: [],
  conflicts: [],
  mods: [],
  rules: [],
  createdAt: '',
  ...extra,
});

describe('checkCompatibility', () => {
  it('flags missing, disabled and out-of-range dependencies with fixes', () => {
    const app = installed(ver('app', '1.0', { requires: ['lib >=2.0.0', 'gone', 'off'] }));
    const lib = installed(ver('lib', '1.5'));
    const off = installed(ver('off', '1.0'), { enabled: false });
    const r = checkCompatibility(profile([app, lib, off]), []);
    const codes = r.issues.map((i) => i.code).sort();
    expect(codes).toEqual(['disabled-dep', 'missing-dep', 'version-mismatch']);
    expect(r.issues.find((i) => i.code === 'missing-dep')!.fix).toMatchObject({ kind: 'install', ref: ref('gone') });
    expect(r.issues.find((i) => i.code === 'disabled-dep')!.fix).toMatchObject({ kind: 'enable', key: 'modrinth:off' });
    expect(r.errors).toBe(3);
    expect(r.score).toBeLessThan(60);
  });

  it('flags mods built for another game version or loader', () => {
    const forge = installed(ver('f', '1.0', { loaders: ['forge'] }));
    const old = installed(ver('o', '1.0', { gameVersions: ['1.20.1'] }));
    const quiltOk = installed(ver('q', '1.0', { loaders: ['fabric'] }));
    const r = checkCompatibility(profile([forge, old, quiltOk], { context: { gameDefId: 'minecraft', gameVersion: '1.21.1', loader: 'quilt' } }), []);
    expect(r.issues.map((i) => `${i.code}:${i.subject}`).sort()).toEqual(['incompatible-game:modrinth:o', 'incompatible-loader:modrinth:f']);
  });

  it('reports cycles in order rules', () => {
    const a = installed(ver('a', '1.0'));
    const b = installed(ver('b', '1.0'));
    const r = checkCompatibility(
      profile([a, b], {
        rules: [
          { subject: 'modrinth:a', kind: 'before', other: 'modrinth:b' },
          { subject: 'modrinth:b', kind: 'before', other: 'modrinth:a' },
        ],
      }),
      [],
    );
    expect(r.issues.some((i) => i.code === 'cycle')).toBe(true);
  });

  it('checks links between applied collections', () => {
    const base = coll('base', { version: '1.2.0' });
    const addon = coll('addon', { requires: [{ collectionId: 'base', range: '^2.0.0' }, { collectionId: 'ui' }], conflicts: [{ collectionId: 'other' }] });
    const other = coll('other');
    const r = checkCompatibility(profile([], { collections: ['base', 'addon', 'other'] }), [base, addon, other]);
    expect(r.issues.filter((i) => i.code === 'collection-missing')).toHaveLength(2);
    expect(r.issues.some((i) => i.code === 'collection-conflict')).toBe(true);
  });

  it('warns about two mods writing the same file until a rule decides', () => {
    const a = installed(ver('a', '1.0'));
    const b = installed(ver('b', '1.0'));
    const overlaps = [{ path: 'Data/x.esp', keys: ['modrinth:a', 'modrinth:b'] }];
    const r1 = checkCompatibility(profile([a, b]), [], overlaps);
    const w = r1.issues.find((i) => i.code === 'file-conflict')!;
    expect(w.fix?.kind).toBe('add-rule');
    const r2 = checkCompatibility(profile([a, b], { rules: [w.fix!.rule!] }), [], overlaps);
    expect(r2.issues.some((i) => i.code === 'file-conflict')).toBe(false);
  });
});

describe('computeOrder', () => {
  it('places dependencies first and honours rules', () => {
    const app = installed(ver('app', '1.0', { requires: ['lib'] }));
    const lib = installed(ver('lib', '1.0'));
    const zed = installed(ver('zed', '1.0'));
    const { order, cycles } = computeOrder([app, lib, zed], [{ subject: 'modrinth:zed', kind: 'before', other: 'modrinth:lib' }]);
    expect(cycles).toEqual([]);
    expect(order).toEqual(['modrinth:zed', 'modrinth:lib', 'modrinth:app']);
  });
});

describe('collectOrphans', () => {
  it('removes auto-installed dependencies nothing needs any more, keeps explicit mods', () => {
    const lib = installed(ver('lib', '1.0', { requires: ['core'] }), { reason: 'dependency' });
    const core = installed(ver('core', '1.0'), { reason: 'dependency' });
    const mine = installed(ver('mine', '1.0'));
    const fromColl = installed(ver('c', '1.0'), { reason: 'collection', requiredBy: ['collection:gone'] });
    const p = profile([lib, core, mine, fromColl]);
    expect(collectOrphans(p).sort()).toEqual(['modrinth:c', 'modrinth:core', 'modrinth:lib']);
    expect(Object.keys(p.mods)).toEqual(['modrinth:mine']);
  });

  it('keeps collection mods while the collection is applied', () => {
    const fromColl = installed(ver('c', '1.0'), { reason: 'collection', requiredBy: ['collection:base'] });
    const p = profile([fromColl], { collections: ['base'] });
    expect(collectOrphans(p)).toEqual([]);
  });
});
