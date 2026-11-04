import { create } from 'zustand';
import type { AppState, CompatReport, DownloadView, GameDef, InstallPlan, ManagedGame, Profile } from '../shared/types';
import { api, bridge } from './api';

export type Route = 'mods' | 'discover' | 'graph' | 'collections' | 'downloads' | 'snapshots' | 'settings';
export const ROUTES: Route[] = ['mods', 'discover', 'graph', 'collections', 'downloads', 'snapshots', 'settings'];

export interface ToastItem {
  id: number;
  kind: 'ok' | 'err' | 'info';
  text: string;
  /** one-click return to the snapshot taken before the change */
  undo?: { label: string; snapshotId: string };
}

interface UI {
  ready: boolean;
  state: AppState | null;
  defs: GameDef[];
  downloads: DownloadView[];
  route: Route;
  selected: string | null;
  report: CompatReport | null;
  plan: InstallPlan | null;
  planning: string | null;
  addGameOpen: boolean;
  toasts: ToastItem[];
  init(): Promise<void>;
  go(r: Route): void;
  select(key: string | null): void;
  toast(kind: ToastItem['kind'], text: string, undo?: ToastItem['undo']): void;
  dismiss(id: number): void;
  refreshCompat(): Promise<void>;
  /** Shows the plan sheet for a plan being built. */
  openPlan(label: string, build: () => Promise<InstallPlan | null>): Promise<void>;
  closePlan(): void;
  setAddGame(open: boolean): void;
  /** Runs an action and turns errors into toasts. */
  run<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined>;
}

let toastSeq = 0;
let compatTimer: ReturnType<typeof setTimeout> | null = null;

const routeFromHash = (): Route => {
  const h = location.hash.replace(/^#\/?/, '') as Route;
  return ROUTES.includes(h) ? h : 'mods';
};

export const useUI = create<UI>((set, get) => ({
  ready: false,
  state: null,
  defs: [],
  downloads: [],
  route: routeFromHash(),
  selected: null,
  report: null,
  plan: null,
  planning: null,
  addGameOpen: false,
  toasts: [],

  async init() {
    const [state, defs, downloads] = await Promise.all([api.state(), api.gameDefs(), bridge.downloads('list')]);
    set({ state, defs, downloads, ready: true });
    applyTheme(state.settings.theme);
    bridge.on('state', (s) => {
      const prev = get().state?.settings.theme;
      set({ state: s });
      if (prev !== s.settings.theme) applyTheme(s.settings.theme);
      scheduleCompat();
    });
    bridge.on('downloads', (d) => set({ downloads: d }));
    bridge.on('toast', (t) => get().toast(t.kind, t.text, t.undo));
    // an nxm:// link from nexusmods.com arrives as a ready plan
    bridge.on('plan', (p) => set({ plan: p, planning: null }));
    window.addEventListener('hashchange', () => set({ route: routeFromHash() }));
    void get().refreshCompat();
  },

  go(r) {
    if (location.hash !== `#/${r}`) location.hash = `#/${r}`;
    set({ route: r });
  },

  select(key) {
    set({ selected: key });
  },

  toast(kind, text, undo) {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text, undo }] }));
    // a toast that offers undo stays long enough to use it
    setTimeout(() => get().dismiss(id), kind === 'err' ? 9000 : undo ? 10000 : 4500);
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },

  async refreshCompat() {
    const p = activeProfile(get().state);
    if (!p) return set({ report: null });
    try {
      const report = await api.compat(p.id);
      if (activeProfile(get().state)?.id === p.id) set({ report });
    } catch {
      /* keep previous report */
    }
  },

  async openPlan(label, build) {
    set({ planning: label, plan: null });
    try {
      const plan = await build();
      if (get().planning !== label) return; // closed while building
      set({ plan, planning: null });
    } catch (e) {
      set({ planning: null });
      get().toast('err', (e as Error).message);
    }
  },

  closePlan() {
    set({ plan: null, planning: null });
  },

  setAddGame(open) {
    set({ addGameOpen: open });
  },

  async run(fn, ok) {
    try {
      const r = await fn();
      if (ok) get().toast('ok', ok);
      return r;
    } catch (e) {
      get().toast('err', (e as Error).message);
      return undefined;
    }
  },
}));

function scheduleCompat() {
  if (compatTimer) clearTimeout(compatTimer);
  compatTimer = setTimeout(() => void useUI.getState().refreshCompat(), 120);
}

function applyTheme(t: 'dark' | 'light') {
  document.documentElement.dataset.theme = t;
  void bridge.setTheme(t);
}

export function activeGame(s: AppState | null): ManagedGame | undefined {
  if (!s) return undefined;
  return s.games.find((g) => g.id === s.activeGameId) ?? s.games[0];
}

export function activeProfile(s: AppState | null): Profile | undefined {
  const g = activeGame(s);
  return g ? s!.profiles.find((p) => p.id === g.activeProfileId) : undefined;
}

export function useActive() {
  const state = useUI((s) => s.state);
  const defs = useUI((s) => s.defs);
  const game = activeGame(state);
  const profile = activeProfile(state);
  const def = game ? defs.find((d) => d.id === game.defId) : undefined;
  return { state, game, profile, def };
}
