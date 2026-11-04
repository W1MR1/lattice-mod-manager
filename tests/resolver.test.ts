import { describe, expect, it } from 'vitest';
import { resolvePlan, type ResolveInput } from '../electron/core/resolver';
import { installed, profile, provider, ref, ver } from './fixtures';

const input = (p: ReturnType<typeof profile>, ids: string[], extra: Partial<ResolveInput> = {}): ResolveInput => ({
  profile: p,
  requests: ids.map((id) => ({ ref: ref(id) })),
  reason: 'explicit',
  includeRecommended: false,
  allowUpdates: true,
  label: 'test',
  ...extra,
});

describe('resolvePlan', () => {
  it('pulls the newest dependency version that satisfies the range and the game context', async () => {
    const prov = provider([
      ver('app', '1.0', { requires: ['lib >=1.2.0'] }),
      ver('lib', '1.0'),
      ver('lib', '1.3'),
      ver('lib', '1.5', { gameVersions: ['1.20.1'] }), // wrong game version
    ]);
    const plan = await resolvePlan(input(profile(), ['app']), prov, 'x');
    expect(plan.ok).toBe(true);
    expect(plan.install.map((i) => `${i.key}@${i.version.version}`).sort()).toEqual(['modrinth:app@1.0', 'modrinth:lib@1.3']);
    const lib = plan.install.find((i) => i.key === 'modrinth:lib')!;
    expect(lib.reason).toBe('dependency');
    expect(lib.requiredBy).toEqual(['modrinth:app']);
  });

  it('reports an unresolvable conflict between two version ranges', async () => {
    const prov = provider([
      ver('a', '1.0', { requires: ['lib <2.0.0'] }),
      ver('b', '1.0', { requires: ['lib >=2.0.0'] }),
      ver('lib', '1.9'),
      ver('lib', '2.1'),
    ]);
    const plan = await resolvePlan(input(profile(), ['a', 'b']), prov, 'x');
    expect(plan.ok).toBe(false);
    expect(plan.issues.some((i) => i.code === 'unresolvable' && i.subject === 'modrinth:lib')).toBe(true);
  });

  it('detects declared incompatibilities', async () => {
    const prov = provider([
      ver('opt', '1.0', { deps: [{ ref: ref('sodium'), kind: 'conflicts' }] }),
      ver('sodium', '1.0'),
    ]);
    const plan = await resolvePlan(input(profile([installed(ver('sodium', '1.0'))]), ['opt']), prov, 'x');
    expect(plan.ok).toBe(false);
    const c = plan.issues.find((i) => i.code === 'conflict')!;
    expect(c.fix?.kind).toBe('disable');
  });

  it('keeps installed versions pinned unless updates are allowed', async () => {
    const lib10 = ver('lib', '1.0');
    const prov = provider([ver('app', '1.0', { requires: ['lib >=1.2.0'] }), lib10, ver('lib', '1.4')]);
    const p = profile([installed(lib10)]);

    const strict = await resolvePlan(input(p, ['app'], { allowUpdates: false }), prov, 'x');
    expect(strict.ok).toBe(false);
    expect(strict.issues[0].code).toBe('version-mismatch');

    const loose = await resolvePlan(input(p, ['app']), prov, 'y');
    expect(loose.ok).toBe(true);
    expect(loose.update.map((u) => `${u.key}:${u.fromVersion}->${u.version.version}`)).toEqual(['modrinth:lib:1.0->1.4']);
  });

  it('does not upgrade a library past what an installed dependent allows', async () => {
    const lib1 = ver('lib', '1.0');
    const old = ver('old', '1.0', { requires: ['lib <2.0.0'] });
    const prov = provider([lib1, ver('lib', '1.8'), ver('lib', '2.0'), old]);
    const p = profile([installed(lib1, { reason: 'dependency' }), installed(old)]);
    const plan = await resolvePlan(input(p, ['lib']), prov, 'x');
    expect(plan.ok).toBe(true);
    expect(plan.update[0].version.version).toBe('1.8');
  });

  it('treats a mod that provides another as satisfying the dependency', async () => {
    const prov = provider([ver('app', '1.0', { requires: ['fabric-api'] }), ver('qfapi', '1.0', { provides: ['modrinth:fabric-api'] }), ver('fabric-api', '1.0')]);
    const p = profile([installed(ver('qfapi', '1.0', { provides: ['modrinth:fabric-api'] }))]);
    const plan = await resolvePlan(input(p, ['app']), prov, 'x');
    expect(plan.ok).toBe(true);
    expect(plan.install.map((i) => i.key)).toEqual(['modrinth:app']);
  });

  it('suggests recommended dependencies without installing them', async () => {
    const prov = provider([ver('app', '1.0', { deps: [{ ref: ref('extra'), kind: 'recommends' }] }), ver('extra', '1.0')]);
    const plan = await resolvePlan(input(profile(), ['app']), prov, 'x');
    expect(plan.install).toHaveLength(1);
    expect(plan.issues.find((i) => i.code === 'recommended')?.fix?.kind).toBe('install');
  });

  it('prefers the version a collection pinned', async () => {
    const prov = provider([ver('lib', '1.0'), ver('lib', '1.3')]);
    const plan = await resolvePlan(
      input(profile(), [], { requests: [{ ref: ref('lib'), versionId: 'lib@1.0', by: 'collection:c1' }], reason: 'collection' }),
      prov,
      'x',
    );
    expect(plan.install[0].version.version).toBe('1.0');
    expect(plan.install[0].requiredBy).toEqual(['collection:c1']);
  });

  it('drops dependencies that are no longer needed after a version change', async () => {
    // app 2.0 no longer needs `legacy`; app 1.0 did
    const prov = provider([ver('app', '1.0', { requires: ['legacy'] }), ver('app', '2.0', { requires: ['lib >=1.0.0'] }), ver('legacy', '1.0'), ver('lib', '1.0')]);
    const plan = await resolvePlan(input(profile(), ['app']), prov, 'x');
    expect(plan.install.map((i) => i.key).sort()).toEqual(['modrinth:app', 'modrinth:lib']);
  });
});
