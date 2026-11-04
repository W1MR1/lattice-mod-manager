declare const __APP_VERSION__: string;
export const APP_VERSION = __APP_VERSION__;

// Typed bridge to the main process (see electron/preload.ts).
import type { Service, Toast } from '../electron/core/service';
import type { AppState, DownloadView, InstallPlan } from '../shared/types';

type Methods =
  | 'state' | 'gameDefs' | 'detectGames' | 'minecraftVersions' | 'addGame' | 'removeGame' | 'setActiveGame'
  | 'createProfile' | 'updateProfile' | 'deleteProfile' | 'switchProfile' | 'compat' | 'search' | 'project' | 'versions'
  | 'planInstall' | 'planUpdates' | 'planCollection' | 'applyFix' | 'applyPlan' | 'setEnabled' | 'dependentsOf' | 'removeMod'
  | 'addRule' | 'removeRule' | 'setUserLink' | 'importLocal' | 'createCollection' | 'updateCollection' | 'relockCollection'
  | 'deleteCollection' | 'exportCollection' | 'importCollectionFile' | 'importModpack' | 'createProfileForCollection'
  | 'removeCollectionFromProfile' | 'deploy' | 'purge' | 'snapshot' | 'rollback' | 'deleteSnapshot' | 'updateSettings'
  | 'inspectPlan' | 'fomodPrompt' | 'reinstallWithChoices' | 'pluginOrder' | 'setNexusKey' | 'clearNexusKey' | 'handleNxm'
  | 'nexusSsoAvailable' | 'loginWithNexus'
  | 'previewRemoval' | 'removeMods' | 'removeAllMods' | 'deleteLeftovers' | 'launchGame' | 'setGamePath' | 'healthCheck' | 'repair'
  | 'exportProfile' | 'backupAll' | 'restoreBackup' | 'curseforgeAvailable' | 'modrinthAccount' | 'modrinthList';

type Fn<K extends Methods> = Service[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never;
export type Api = { [K in Methods]: Fn<K> };

export type UpdateEvent =
  | { state: 'available'; version: string; notes: string }
  | { state: 'downloading'; percent: number }
  | { state: 'ready'; version: string }
  | { state: 'none' }
  | { state: 'error'; error: string }
  | { state: 'offline'; error: string };

interface Bridge {
  call(method: string, ...args: unknown[]): Promise<unknown>;
  downloads(action: 'list' | 'pause' | 'resume' | 'cancel' | 'clear', id?: string): Promise<DownloadView[]>;
  dialog(kind: 'folder'): Promise<string | null>;
  dialog(kind: 'files'): Promise<string[] | null>;
  dialog(kind: 'collection-open'): Promise<string | null>;
  dialog(kind: 'collection-save', defaultName?: string): Promise<string | null>;
  dialog(kind: 'backup-open'): Promise<string | null>;
  dialog(kind: 'backup-save', defaultName?: string): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  openPath(p: string): Promise<void>;
  fileIcon(p: string): Promise<string | null>;
  pathForFile(f: File): string;
  setTheme(t: 'dark' | 'light'): Promise<void>;
  update(action: 'check' | 'download' | 'install' | 'snooze'): Promise<void>;
  on(event: 'state', cb: (s: AppState) => void): () => void;
  on(event: 'downloads', cb: (d: DownloadView[]) => void): () => void;
  on(event: 'toast', cb: (t: Toast) => void): () => void;
  on(event: 'deployed', cb: (d: unknown) => void): () => void;
  on(event: 'plan', cb: (p: InstallPlan) => void): () => void;
  on(event: 'update', cb: (u: UpdateEvent) => void): () => void;
}

declare global {
  interface Window {
    lattice: Bridge;
  }
}

/** Electron wraps errors as "Error invoking remote method 'x': Error: msg" — keep only msg. */
export function cleanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

export const bridge: Bridge = window.lattice;

export const api = new Proxy({} as Api, {
  get:
    (_t, method: string) =>
    (...args: unknown[]) =>
      bridge.call(method, ...args).catch((e) => {
        throw new Error(cleanError(e));
      }),
});
