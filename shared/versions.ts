// Version helpers tolerant of the loose version strings mods actually use
// ("1.2", "v0.5.0-beta+mc1.21", "mc1.20.1-3.1.4").
import semver from 'semver';
import { t } from './i18n';

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

/**
 * Strict match for "breaks" declarations: true only when the range is one we
 * can read and the version falls in it. A range we cannot read never matches,
 * so an unusual declaration does not raise a false alarm.
 */
export function matchesStrict(version: string | undefined, range: string | undefined): boolean {
  if (!range || range.trim() === '*') return true;
  if (!version) return false;
  const r = semver.validRange(range, { loose: true, includePrerelease: true });
  const v = coerce(version);
  if (!r || !v) return false;
  return semver.satisfies(v, r, { loose: true, includePrerelease: true });
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
  if (!range || range === '*') return t('любая версия');
  return range;
}
