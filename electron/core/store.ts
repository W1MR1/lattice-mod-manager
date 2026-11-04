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
];

export function defaultSettings(dataRoot: string): Settings {
  return {
    dataRoot,
    theme: 'dark',
    maxParallelDownloads: 6,
    maxConnectionsPerFile: 8,
    minSegmentMiB: 1,
    deployMethod: 'hardlink',
    enabledSources: { modrinth: true, thunderstore: true, github: true, nexus: true, local: true },
    trustedHosts: DEFAULT_TRUSTED_HOSTS,
    includeRecommended: false,
    handleNxm: false,
  };
}

export class Store {
  state: Persisted;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private file: string,
    dataRoot: string,
  ) {
    const empty: Persisted = { games: [], profiles: [], collections: [], snapshots: [], settings: defaultSettings(dataRoot), local: {} };
    if (existsSync(file)) {
      try {
        const loaded = JSON.parse(readFileSync(file, 'utf8')) as Partial<Persisted>;
        const settings = { ...empty.settings, ...loaded.settings };
        settings.enabledSources = { ...empty.settings.enabledSources, ...loaded.settings?.enabledSources };
        this.state = { ...empty, ...loaded, settings };
      } catch {
        this.state = empty;
      }
    } else this.state = empty;
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
      await fs.rename(tmp, this.file);
    });
    return this.writing;
  }
}
