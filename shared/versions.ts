// Version helpers tolerant of the loose version strings mods actually use
// ("1.2", "v0.5.0-beta+mc1.21", "mc1.20.1-3.1.4").
import semver from 'semver';

export function coerce(v: string): semver.SemVer | null {
  const clean = semver.clean(v, { loose: true });
  if (clean) return semver.parse(clean);
  return semver.coerce(v, { includePrerelease: true });
}

/** Negative if a < b, positive if a > b. Falls back to string compare. */
export function compareVersions(a: string, b: string): number {
  const ca = coerce(a);
  const cb = coerce(b);
  if (ca && cb) {
    const c = semver.compare(ca, cb);
    if (c !== 0) return c;
  }
  return a.localeCompare(b, undefined, { numeric: true });
}

export function satisfies(version: string, range: string | undefined): boolean {
  if (!range || range === '*' || range.trim() === '') return true;
  const v = coerce(version);
  if (!v) return true;
  try {
    return semver.satisfies(v, range, { loose: true, includePrerelease: true });
  } catch {
    return true;
  }
}

/** Intersection check for display: do any versions satisfy every range? */
export function describeRange(range?: string): string {
  if (!range || range === '*') return 'любая версия';
  return range;
}
