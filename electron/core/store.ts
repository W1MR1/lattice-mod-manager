// Persistent state in one JSON file, written atomically (temp file + rename).
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AppState, Settings } from '../../shared/types';
import type { LocalEntry } from './sources';

export interface Persisted extends AppState {
  local: Record<string, LocalEntry>;
}

export const DEFAULT_TRUSTED_HOSTS = [
  'cdn.modrinth.com',
  'modrinth.com',
  'thunderstore.io',
  'gcdn.thunderstore.io',
  'ccdn.thunderstore.io',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'raw.githubusercontent.com',
  'gitlab.com',
  'nexusmods.com',
  'nexus-cdn.com',
  'gamebanana.com',
  'forgecdn.net',
];

export function defaultSettings(dataRoot: string): Settings {
  return {
    dataRoot,
    theme: 'dark',
    maxParallelDownloads: 6,
    maxConnectionsPerFile: 8,
    minSegmentMiB: 1,
    deployMethod: 'hardlink',
    enabledSources: { modrinth: true, thunderstore: true, github: true, nexus: true, gamebanana: true, curseforge: true, local: true },
    trustedHosts: DEFAULT_TRUSTED_HOSTS,
    includeRecommended: false,
    handleNxm: false,
  };
}

export class Store {
  state: Persisted;

  /** Copies the state file aside, e.g. before a backup is restored over it. */
  async keepCopy(suffix: string) {
    await this.flush();
    await fs.copyFile(this.file, this.file + suffix).catch(() => undefined);
  }

  /** true when state.json was unreadable and the last good copy was loaded */
  recovered = false;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private file: string,
    dataRoot: string,
  ) {
    const empty: Persisted = { games: [], profiles: [], collections: [], snapshots: [], settings: defaultSettings(dataRoot), local: {} };
    const read = (f: string): Persisted | null => {
      try {
        const loaded = JSON.parse(readFileSync(f, 'utf8')) as Partial<Persisted>;
        const settings = { ...empty.settings, ...loaded.settings };
        settings.enabledSources = { ...empty.settings.enabledSources, ...loaded.settings?.enabledSources };
        // hosts of sources added in later versions; ones the user removed stay removed
        const seen = new Set(settings.trustedHostsSeen ?? settings.trustedHosts);
        for (const h of DEFAULT_TRUSTED_HOSTS) if (!seen.has(h) && !settings.trustedHosts.includes(h)) settings.trustedHosts = [...settings.trustedHosts, h];
        settings.trustedHostsSeen = [...new Set([...(settings.trustedHostsSeen ?? []), ...DEFAULT_TRUSTED_HOSTS])];
        return { ...empty, ...loaded, settings };
      } catch {
        return null;
      }
    };
    if (!existsSync(file)) this.state = empty;
    else {
      const main = read(file);
      const backup = main ? null : read(`${file}.bak`);
      this.recovered = !main && !!backup;
      this.state = main ?? backup ?? empty;
    }
  }

  save() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), 150);
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const data = JSON.stringify(this.state, null, 1);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, data);
      // the last good file becomes the backup a broken write can fall back to
      await fs.copyFile(this.file, `${this.file}.bak`).catch(() => undefined);
      await fs.rename(tmp, this.file);
    });
    return this.writing;
  }
}
