// The application service: everything the UI can ask for. Free of Electron
// APIs so it can be driven from tests and scripts as well.
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  AppState,
  Collection,
  CompatReport,
  DepDecl,
  DeployResult,
  Fix,
  GameContext,
  InstallPlan,
  InstalledMod,
  Issue,
  ManagedGame,
  ModFile,
  ModProject,
  ModRef,
  ModVersion,
  OrderRule,
  PlanItem,
  PlanRequest,
  Profile,
  SearchQuery,
  SearchResult,
  Settings,
  Snapshot,
} from '../../shared/types';
import type { CollectionMod, FomodPrompt, GameDef, HealthProblem, InstallInfo } from '../../shared/types';
import { keyOf } from '../../shared/types';
import { defaultChoices, validateChoices, type FileState, type FomodChoices } from '../../shared/fomod';
import { checkCompatibility, type PluginCheck, type PluginInfo } from './compat';
import { collectionClosure, fromProfile, importMrpack, parseCollection, slugId, type CollectionMeta } from './collections';
import { computeOverlaps, deploy, deployDrift, forgetStaged, ownedFiles, purge, stagedFiles, type DeployFailure, type DeployOptions } from './deployer';
import { readJarMeta, type JarMeta } from './jarmeta';
import { DownloadManager } from './downloader';
import { archiveKind } from './archives';
import { GAME_DEFS, gameDef } from './games';
import { detectAll, inspectFolder, launcherName, samePath, systemEnv, type DetectEnv } from './detect';
import { FomodRequired, inspectFomod, STAGED_PREFIX, safeName, stageVersion, walk } from './installer';
import { computeOrder, providerIndex } from './loadorder';
import { PLUGIN_EXT, pluginMasters, pluginsTxtPath, restorePluginsTxt, writePluginsTxt } from './plugins';
import { resolvePlan, type ProjectMeta, type VersionProvider } from './resolver';
import { violatesStrict } from '../../shared/versions';
import { loaderFits } from '../../shared/context';
import { Sources } from './sources';
import { CurseForgeSource } from './sources/curseforge';
import { removeVortexLeftovers, scanManagers, vortexDeployedFiles, type ImportSource } from './importers';
import { mapPool } from './http';
import { parseNexusUrl, parseNxm, type NxmLink } from './sources/nexus';
import { Store } from './store';
import { collectOrphans, recomputeLinks } from './links';
import { applyRemoval, planRemoval, type RemovalOptions } from './removal';
import { scanLeftovers, type Leftover } from './cleanup';
import { findMinecraftLauncher, gameLaunchTarget, installMinecraftLoader, type LaunchTarget } from './launch';
export { collectOrphans, recomputeLinks } from './links';
import { APP_VERSION, CURSEFORGE_KEY, NEXUS_SLUG } from './app-info';
import { defaultSettings, type Persisted } from './store';
import { nexusSso } from './nexus-sso';
import { LANGS, plural, setLang, t } from '../../shared/i18n';

export type Toast = { kind: 'ok' | 'err' | 'info'; text: string; undo?: { label: string; snapshotId: string } };

/** Encrypts secrets at rest; main passes the OS keychain (Electron safeStorage). */
export interface Secrets {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

const plainSecrets: Secrets = {
  encrypt: (s) => Buffer.from(s, 'utf8').toString('base64'),
  decrypt: (s) => Buffer.from(s, 'base64').toString('utf8'),
};

const MAX_SNAPSHOTS = 30;
/** how many versions of one mod a plan reads the jars of, newest first, looking for one that fits */
const JAR_CHECKS = 8;

export class Service extends EventEmitter {
  readonly store: Store;
  readonly sources: Sources;
  readonly downloads: DownloadManager;
  private plans = new Map<string, InstallPlan>();
  /** download keys from nxm:// links, by "<domain>/<modId>/<fileId>" */
  private nxmKeys = new Map<string, NxmLink>();

  constructor(
    stateFile: string,
    dataRoot: string,
    private secrets: Secrets = plainSecrets,
    /** opens a page in the user's browser (Nexus sign-in) */
    private openBrowser: (url: string) => void | Promise<void> = () => undefined,
    /** starts a game: through Steam or an executable (main checks both) */
    private launcher: (t: LaunchTarget) => Promise<void> = async () => {
      throw new Error(t('Запуск игр недоступен'));
    },
    /** where to look for games and launchers (a fake one in tests) */
    private env: DetectEnv = systemEnv(),
  ) {
    super();
    this.store = new Store(stateFile, dataRoot);
    if (this.settings.language) setLang(this.settings.language);
    this.sources = new Sources(
      () => this.dir('cache'),
      gameDef,
      () => this.settings.githubToken,
      () => this.store.state.local,
      () => this.nexusKey(),
      () => this.settings.curseforgeKey || CURSEFORGE_KEY || undefined,
      () => this.settings.modrinthToken || undefined,
    );
    this.downloads = new DownloadManager(() => ({
      maxParallel: this.settings.maxParallelDownloads,
      maxConnections: this.settings.maxConnectionsPerFile,
      minSegmentBytes: Math.max(256 * 1024, this.settings.minSegmentMiB * 1024 * 1024),
    }));
  }

  // ---------- basics

  get settings(): Settings {
    return this.store.state.settings;
  }

  private dir(...p: string[]) {
    return path.join(this.settings.dataRoot, ...p);
  }

  /** Public state: secrets never leave the main process. */
  state(): AppState {
    const { local: _local, ...pub } = this.store.state;
    const { nexusKeyEnc: _key, ...settings } = pub.settings;
    const mask = (v?: string) => (v ? '••••' : undefined);
    return {
      ...pub,
      settings: { ...settings, githubToken: mask(settings.githubToken), curseforgeKey: mask(settings.curseforgeKey), modrinthToken: mask(settings.modrinthToken) },
    };
  }

  private nexusKey(): string | undefined {
    const enc = this.settings.nexusKeyEnc;
    if (!enc) return undefined;
    try {
      return this.secrets.decrypt(enc);
    } catch {
      return undefined;
    }
  }

  private changed() {
    this.store.save();
    this.emit('state', this.state());
  }

  private toast(kind: Toast['kind'], text: string, undo?: Toast['undo']) {
    this.emit('toast', { kind, text, undo } satisfies Toast);
  }

  private profile(id: string): Profile {
    const p = this.store.state.profiles.find((x) => x.id === id);
    if (!p) throw new Error(t('Профиль не найден'));
    return p;
  }

  private game(id: string): ManagedGame {
    const g = this.store.state.games.find((x) => x.id === id);
    if (!g) throw new Error(t('Игра не найдена'));
    return g;
  }

  private defOf(game: ManagedGame) {
    const d = gameDef(game.defId);
    if (!d) throw new Error(t('Неизвестная игра {0}', game.defId));
    return d;
  }

  // ---------- games and profiles

  gameDefs() {
    return GAME_DEFS;
  }

  async detectGames() {
    return detectAll(this.env, (await findMinecraftLauncher()) ?? undefined);
  }

  /** Store or launcher of a game copy, worked out once and kept. */
  private async installInfo(game: ManagedGame): Promise<InstallInfo> {
    if (!game.install) {
      game.install = (await inspectFolder(game.defId, game.installPath, this.env, (await findMinecraftLauncher()) ?? undefined)).install;
      this.changed();
    }
    return game.install;
  }

  /** Launcher executables Lattice found itself; main starts nothing else outside a game folder. */
  launcherExecutables(): string[] {
    return this.store.state.games.map((g) => g.install?.launcherExe).filter(Boolean) as string[];
  }

  private pluginsFolder(game: ManagedGame, def: GameDef): string {
    const base = def.pluginsTxt!.folder;
    if (def.id !== 'skyrimse') return base;
    // Skyrim SE keeps plugins.txt in a folder of its own for each store
    const suffix: Partial<Record<string, string>> = { gog: ' GOG', epic: ' EPIC', xbox: ' MS' };
    return base + (suffix[game.install?.store ?? ''] ?? '');
  }

  async minecraftVersions(): Promise<string[]> {
    return this.sources.modrinth.gameVersions();
  }

  async addGame(defId: string, installPath: string, ctx: Partial<GameContext> = {}): Promise<ManagedGame> {
    const def = gameDef(defId);
    if (!def) throw new Error(t('Неизвестная игра'));
    const st = await fs.stat(installPath).catch(() => null);
    if (!st?.isDirectory()) throw new Error(t('Папка игры не найдена'));
    // which launcher or store the folder belongs to; a Prism instance folder becomes its game folder
    const found = await inspectFolder(defId, installPath, this.env, (await findMinecraftLauncher()) ?? undefined);
    installPath = found.path;
    const id = `${defId}-${randomUUID().slice(0, 6)}`;
    const profile: Profile = {
      id: randomUUID(),
      gameId: id,
      name: t('Основной'),
      context: { gameDefId: defId, gameVersion: ctx.gameVersion ?? found.gameVersion, loader: ctx.loader ?? found.loader ?? def.loaders?.[0] },
      mods: {},
      rules: [],
      collections: [],
      createdAt: new Date().toISOString(),
    };
    const game: ManagedGame = { id, defId, name: def.name, installPath, activeProfileId: profile.id, addedAt: new Date().toISOString(), install: found.install };
    this.store.state.games.push(game);
    this.store.state.profiles.push(profile);
    this.store.state.activeGameId = id;
    this.changed();
    return game;
  }

  async removeGame(id: string) {
    this.game(id);
    await this.purge(id); // files the game still holds open would otherwise stay there for good
    const s = this.store.state;
    const profileIds = new Set(s.profiles.filter((p) => p.gameId === id).map((p) => p.id));
    s.games = s.games.filter((g) => g.id !== id);
    s.profiles = s.profiles.filter((p) => p.gameId !== id);
    s.snapshots = s.snapshots.filter((x) => !profileIds.has(x.profileId));
    if (s.activeGameId === id) s.activeGameId = s.games[0]?.id;
    this.changed();
    this.tidy();
  }

  setActiveGame(id: string) {
    this.game(id);
    this.store.state.activeGameId = id;
    this.changed();
  }

  createProfile(gameId: string, name: string, context?: Partial<GameContext>, copyFrom?: string): Profile {
    const game = this.game(gameId);
    const base = copyFrom ? this.profile(copyFrom) : this.profile(game.activeProfileId);
    const p: Profile = {
      id: randomUUID(),
      gameId,
      name: name || t('Новый профиль'),
      context: { ...base.context, ...context, gameDefId: game.defId },
      mods: copyFrom ? structuredClone(base.mods) : {},
      rules: copyFrom ? structuredClone(base.rules) : [],
      collections: copyFrom ? [...base.collections] : [],
      createdAt: new Date().toISOString(),
    };
    this.store.state.profiles.push(p);
    this.changed();
    return p;
  }

  updateProfile(id: string, patch: { name?: string; context?: Partial<GameContext> }) {
    const p = this.profile(id);
    if (patch.name) p.name = patch.name;
    if (patch.context) p.context = { ...p.context, ...patch.context, gameDefId: p.context.gameDefId };
    this.changed();
  }

  async deleteProfile(id: string) {
    const p = this.profile(id);
    const game = this.game(p.gameId);
    const others = this.store.state.profiles.filter((x) => x.gameId === p.gameId && x.id !== id);
    if (others.length === 0) throw new Error(t('Нельзя удалить единственный профиль игры'));
    if (game.activeProfileId === id) await this.switchProfile(game.id, others[0].id);
    this.store.state.profiles = this.store.state.profiles.filter((x) => x.id !== id);
    this.store.state.snapshots = this.store.state.snapshots.filter((s) => s.profileId !== id);
    this.changed();
    this.tidy();
  }

  async switchProfile(gameId: string, profileId: string) {
    const game = this.game(gameId);
    this.profile(profileId);
    if (game.activeProfileId === profileId) return;
    await this.purge(gameId); // stop here rather than mix two profiles in the game folder
    game.activeProfileId = profileId;
    this.changed();
    await this.deploy(profileId).catch((e) => this.toast('err', t('Развёртывание: {0}', (e as Error).message)));
  }

  // ---------- compatibility

  async compat(profileId: string): Promise<CompatReport> {
    const p = this.profile(profileId);
    const { order } = computeOrder(Object.values(p.mods), p.rules);
    const overlaps = await computeOverlaps(order, p.mods).catch(() => []);
    const game = this.game(p.gameId);
    const def = this.defOf(game);
    const pluginCheck = def.pluginsTxt ? await this.pluginCheck(p, game, def, order) : undefined;
    const jars = def.kind === 'minecraft' ? await this.jarMetas(p).catch(() => undefined) : undefined;
    return checkCompatibility(p, this.store.state.collections, overlaps, pluginCheck, jars);
  }

  private jarCache = new Map<string, { mtime: number; meta: JarMeta }>();

  /** What the jars of each enabled Minecraft mod declare, read once per file. */
  private async jarMetas(p: Profile): Promise<Map<string, JarMeta>> {
    const out = new Map<string, JarMeta>();
    for (const m of Object.values(p.mods)) {
      if (!m.enabled || !m.stagedPath) continue;
      const jars = (await stagedFiles(m.stagedPath).catch(() => [] as string[])).filter((r) => /^mods\/[^/]+\.jar$/i.test(r));
      const metas: JarMeta[] = [];
      for (const rel of jars) {
        const file = path.join(m.stagedPath, rel);
        const st = await fs.stat(file).catch(() => null);
        if (!st) continue;
        const hit = this.jarCache.get(file);
        if (hit && hit.mtime === st.mtimeMs) metas.push(hit.meta);
        else {
          const meta = await readJarMeta(file);
          this.jarCache.set(file, { mtime: st.mtimeMs, meta });
          metas.push(meta);
        }
      }
      if (metas.length) out.set(m.key, mergeJarMeta(metas));
    }
    return out;
  }

  /** Plugins the enabled mods ship (in load order) and what the game already has. */
  private async pluginCheck(p: Profile, game: ManagedGame, def: GameDef, order: string[]): Promise<PluginCheck> {
    const plugins: PluginInfo[] = [];
    for (const key of order) {
      const m = p.mods[key];
      if (!m?.enabled || !m.stagedPath) continue;
      const files = (await walk(m.stagedPath).catch(() => [])).filter((f) => !f.includes('/') && PLUGIN_EXT.test(f)).sort();
      for (const f of files) plugins.push({ owner: key, name: f, masters: await pluginMasters(path.join(m.stagedPath, f)).catch(() => []) });
    }
    const dataDir = path.join(game.installPath, def.deployDir);
    const inGame = (await fs.readdir(dataDir).catch(() => [] as string[])).filter((f) => PLUGIN_EXT.test(f));
    return { plugins, available: [...(def.pluginsTxt?.baseMasters ?? []), ...inGame] };
  }

  /** Load order Lattice writes to plugins.txt for this profile. */
  async pluginOrder(profileId: string): Promise<{ name: string; owner: string; title: string; masters: string[] }[]> {
    const p = this.profile(profileId);
    const game = this.game(p.gameId);
    const def = this.defOf(game);
    if (!def.pluginsTxt) return [];
    const { order } = computeOrder(Object.values(p.mods), p.rules);
    const check = await this.pluginCheck(p, game, def, order);
    const list = check.plugins.map((x) => ({ ...x, title: p.mods[x.owner]?.title ?? x.owner }));
    return [...list.filter((x) => /\.(esm|esl)$/i.test(x.name)), ...list.filter((x) => !/\.(esm|esl)$/i.test(x.name))];
  }

  /** FOMOD fileDependency conditions look at plugins that are active right now. */
  private async fileState(p: Profile): Promise<{ state: FileState; active: string[] }> {
    const game = this.game(p.gameId);
    const def = this.defOf(game);
    if (!def.pluginsTxt) return { state: () => 'Missing', active: [] };
    const { order } = computeOrder(Object.values(p.mods), p.rules);
    const check = await this.pluginCheck(p, game, def, order);
    const active = [...check.available, ...check.plugins.map((x) => x.name)];
    const set = new Set(active.map((n) => n.toLowerCase()));
    return { state: (f) => (set.has(f.toLowerCase()) ? 'Active' : 'Missing'), active };
  }

  // ---------- sources

  search(q: SearchQuery): Promise<SearchResult> {
    if (!this.settings.enabledSources[q.source]) return Promise.resolve({ hits: [], total: 0, offset: 0 });
    return this.sources.search(q);
  }

  project(ref: ModRef, ctx: GameContext): Promise<ModProject | null> {
    return this.sources.project(ref, ctx);
  }

  async versions(ref: ModRef, profileId: string): Promise<ModVersion[]> {
    const p = this.profile(profileId);
    return this.checkedProvider(p).versions(ref, p.context);
  }

  // ---------- planning

  /** downloaded jars, by url: what they declare */
  private jarOfUrl = new Map<string, JarMeta>();
  /** versions left out of the last plan because their jars do not fit */
  private jarRejected = 0;

  /**
   * Versions of a Minecraft mod that come without game versions or loaders
   * (GitHub, GameBanana, hand-made collections) are checked by the jar itself
   * before a plan offers them: newest first, until one fits. Those made for
   * another Minecraft version or loader are left out, so the plan never picks
   * them. A jar that cannot be read or downloaded is not held against a version.
   */
  private checkedProvider(p: Profile, overlay?: Map<string, ModVersion[]>, overlayMeta?: Map<string, ProjectMeta>): VersionProvider {
    const base = this.sources.provider(p.context, overlay, overlayMeta);
    const ctx = p.context;
    const game = this.store.state.games.find((g) => g.id === p.gameId);
    if (!game || this.defOf(game).kind !== 'minecraft' || (!ctx.gameVersion && !ctx.loader)) return base;
    const unknown = (v: ModVersion) => v.files.some((f) => /\.jar$/i.test(f.filename)) && ((!v.gameVersions.length && !!ctx.gameVersion) || (!v.loaders.length && !!ctx.loader));
    return {
      meta: (refs) => base.meta(refs),
      versions: async (ref, c) => {
        const list = await base.versions(ref, c);
        const drop = new Set<ModVersion>();
        let checked = 0;
        let found = false;
        for (const v of [...list].sort((a, b) => Date.parse(b.published) - Date.parse(a.published))) {
          if (found || !unknown(v)) continue;
          if (checked++ >= JAR_CHECKS) {
            drop.add(v); // older than everything checked, and nothing fitted so far
            continue;
          }
          if (await this.jarFits(v, p).catch(() => true)) found = true;
          else drop.add(v);
        }
        this.jarRejected += drop.size;
        return list.filter((v) => !drop.has(v));
      },
    };
  }

  /** Do the jars of a version fit the profile's Minecraft version and loader? */
  private async jarFits(v: ModVersion, p: Profile): Promise<boolean> {
    for (const f of v.files.filter((x) => /\.jar$/i.test(x.filename))) {
      let meta = this.jarOfUrl.get(f.url);
      if (!meta) {
        meta = await readJarMeta(await this.fetchFile(f, `${v.ref.projectId} ${v.version}`, p.gameId));
        this.jarOfUrl.set(f.url, meta);
      }
      const mc = meta.depends.find((d) => d.id.toLowerCase() === 'minecraft');
      if (mc && violatesStrict(p.context.gameVersion, mc.range)) return false;
      if (p.context.loader && meta.loaders?.length && !loaderFits(meta.loaders, p.context.loader)) return false;
    }
    return true;
  }

  private storePlan(plan: InstallPlan): InstallPlan {
    this.plans.set(plan.id, plan);
    if (this.plans.size > 20) this.plans.delete(this.plans.keys().next().value!);
    return plan;
  }

  async planInstall(profileId: string, requests: PlanRequest[], opts: { allowUpdates?: boolean; label?: string } = {}): Promise<InstallPlan> {
    const p = this.profile(profileId);
    const label = opts.label ?? (requests.length === 1 ? t('Установка «{0}»', requests[0].title ?? requests[0].ref.projectId) : t('Установка {0} модов', requests.length));
    this.busy++; // jars checked while planning stay in the cache for the install
    this.jarRejected = 0;
    const plan = await resolvePlan(
      { profile: p, requests, reason: 'explicit', includeRecommended: this.settings.includeRecommended, allowUpdates: opts.allowUpdates ?? true, label },
      this.checkedProvider(p),
      randomUUID(),
    ).finally(() => this.busy--);
    attachChoices(plan, p);
    this.storePlan(plan);
    if (this.jarRejected) this.tidy();
    return plan;
  }

  async planUpdates(profileId: string, keys?: string[]): Promise<InstallPlan> {
    const p = this.profile(profileId);
    const targets = (keys ?? Object.keys(p.mods)).map((k) => p.mods[k]).filter((m) => m && m.enabled && m.ref.source !== 'local');
    return this.planInstall(
      profileId,
      targets.map((m) => ({ ref: m.ref, title: m.title })),
      { allowUpdates: true, label: keys?.length === 1 ? t('Обновление «{0}»', targets[0]?.title) : t('Безопасное обновление модов') },
    );
  }

  async planCollection(profileId: string, collectionId: string): Promise<InstallPlan> {
    const p = this.profile(profileId);
    const all = this.store.state.collections;
    const { order: chain, missing } = collectionClosure(collectionId, all);
    const target = chain[chain.length - 1];
    if (!target) throw new Error(t('Коллекция не найдена'));
    const extra: Issue[] = [];
    if (target.game.defId !== p.context.gameDefId) throw new Error(t('Коллекция «{0}» для другой игры', target.name));
    if ((target.game.gameVersion && target.game.gameVersion !== p.context.gameVersion) || (target.game.loader && target.game.loader !== p.context.loader)) {
      extra.push({
        id: `ctx:${target.id}`,
        severity: 'warning',
        code: 'incompatible-game',
        subject: `collection:${target.id}`,
        related: [],
        message: t('Коллекция собрана для {0}, а профиль — {1}. Закреплённые версии могут быть заменены. Надёжнее создать отдельный профиль под коллекцию.', [target.game.gameVersion, target.game.loader].filter(Boolean).join(' + '), [p.context.gameVersion, p.context.loader].filter(Boolean).join(' + ')),
      });
    }
    for (const m of missing) {
      extra.push({
        id: `missing:${m.collectionId}`,
        severity: 'error',
        code: 'collection-missing',
        subject: `collection:${target.id}`,
        related: [`collection:${m.collectionId}`],
        message: t('Коллекция строится поверх «{0}»{1}, но её нет в библиотеке. Импортируйте её.', m.name ?? m.collectionId, m.range ? ` ${m.range}` : ''),
      });
    }
    const chainIds = new Set(chain.map((c) => c.id));
    const appliedIds = new Set([...p.collections, ...chainIds]);
    for (const c of all.filter((x) => appliedIds.has(x.id))) {
      for (const link of c.conflicts) {
        if (!appliedIds.has(link.collectionId) || !(chainIds.has(c.id) || chainIds.has(link.collectionId))) continue;
        const other = all.find((x) => x.id === link.collectionId);
        extra.push({
          id: `cconf:${c.id}:${link.collectionId}`,
          severity: 'error',
          code: 'collection-conflict',
          subject: `collection:${c.id}`,
          related: [`collection:${link.collectionId}`],
          message: t('«{0}» несовместима с «{1}»{2}.', c.name, other?.name ?? link.collectionId, link.reason ? `: ${link.reason}` : ''),
        });
      }
    }

    const overlay = new Map<string, ModVersion[]>();
    const overlayMeta = new Map<string, ProjectMeta>();
    const requests: PlanRequest[] = [];
    for (const c of chain) {
      for (const m of c.mods) {
        if (m.optional) continue;
        const k = keyOf(m.ref);
        const v: ModVersion = {
          ref: m.ref,
          versionId: m.versionId,
          version: m.version,
          gameVersions: m.gameVersions,
          loaders: m.loaders,
          published: c.createdAt,
          files: m.files,
          deps: m.deps,
        };
        overlay.set(k, [...(overlay.get(k) ?? []).filter((x) => x.versionId !== v.versionId), v]);
        overlayMeta.set(k, { title: m.title });
        requests.push({ ref: m.ref, versionId: m.versionId, title: m.title, by: `collection:${c.id}` });
      }
    }
    this.busy++;
    this.jarRejected = 0;
    const plan = await resolvePlan(
      { profile: p, requests, reason: 'collection', includeRecommended: false, allowUpdates: true, label: t('Коллекция «{0}»', target.name) },
      this.checkedProvider(p, overlay, overlayMeta),
      randomUUID(),
    ).finally(() => this.busy--);
    plan.issues = [...extra, ...plan.issues];
    plan.ok = !plan.issues.some((i) => i.severity === 'error');
    plan.collectionIds = chain.map((c) => c.id);
    // FOMOD options locked in the collection replay without questions.
    const locked = new Map<string, FomodChoices>();
    for (const c of chain) for (const m of c.mods) if (m.choices) locked.set(keyOf(m.ref), m.choices);
    attachChoices(plan, p, locked);
    this.storePlan(plan);
    if (this.jarRejected) this.tidy();
    return plan;
  }

  /** Applies a quick fix; returns a plan when the fix needs downloads. */
  async applyFix(profileId: string, fix: Fix): Promise<InstallPlan | null> {
    switch (fix.kind) {
      case 'install':
        return this.planInstall(profileId, [{ ref: fix.ref!, versionId: fix.versionId }]);
      case 'update':
        return this.planUpdates(profileId, [fix.key!]);
      case 'enable':
      case 'disable':
        await this.setEnabled(profileId, fix.key!, fix.kind === 'enable');
        return null;
      case 'add-rule':
        await this.addRule(profileId, fix.rule!);
        return null;
      case 'apply-collection':
        return this.planCollection(profileId, fix.collectionId!);
    }
  }

  // ---------- applying

  private isTrusted(url: string): boolean {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:') return false;
    return this.settings.trustedHosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  }

  private cachePath(f: ModFile): string {
    const id = f.hashes.sha1 ?? f.hashes.sha256 ?? f.hashes.sha512?.slice(0, 64) ?? createHash('sha1').update(f.url).digest('hex');
    return this.dir('downloads', id.slice(0, 2), id, safeName(f.filename));
  }

  private async fetchFile(f: ModFile, title: string, gameId?: string): Promise<string> {
    if (f.url.startsWith(STAGED_PREFIX)) return f.url.slice(STAGED_PREFIX.length);
    if (f.url.startsWith('file:')) return fileURLToPath(f.url);
    const dest = this.cachePath(f);
    // A finished download is renamed from .part only when complete, so an existing
    // file is whole; files with hashes are re-verified by the downloader instead.
    if (!(f.hashes.sha1 || f.hashes.sha256 || f.hashes.sha512) && (await fs.stat(dest).catch(() => null))?.isFile()) return dest;
    const nexus = parseNexusUrl(f.url);
    if (nexus) {
      const nxm = this.nxmKeys.get(`${nexus.domain}/${nexus.modId}/${nexus.fileId}`);
      const url = await this.sources.nexus.downloadLink(nexus.domain, nexus.modId, nexus.fileId, nxm);
      if (!this.isTrusted(url)) throw new Error(t('Nexus вернул ссылку на неизвестный хост: {0}', new URL(url).hostname));
      // collections sometimes name a file by its storage hash: the link carries the real name and extension
      if (!archiveKind(f.filename)) {
        const real = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
        if (archiveKind(real)) f.filename = real;
      }
      const ndest = this.cachePath(f);
      if ((await fs.stat(ndest).catch(() => null))?.isFile() && !(f.hashes.sha1 || f.hashes.sha256 || f.hashes.sha512 || f.hashes.md5)) return ndest;
      // Free accounts are limited by Nexus per connection; one connection keeps within their terms.
      const premium = this.settings.nexusUser?.premium === true;
      return this.downloads.enqueue({ url, dest: ndest, title, size: f.size, hashes: f.hashes, maxConnections: premium ? undefined : 1, gameId }).done;
    }
    if (!this.isTrusted(f.url)) {
      let host = f.url;
      try {
        host = new URL(f.url).hostname;
      } catch {
        /* keep url */
      }
      throw new Error(t('источник {0} не в списке доверенных (Настройки → Источники)', host));
    }
    return this.downloads.enqueue({ url: f.url, dest, title, size: f.size, hashes: f.hashes, gameId }).done;
  }

  /**
   * A locked version that came without files (a hand-made or partial collection):
   * the files come from its source — the same file id, else the same version
   * number, else the newest main file. Returns the version unchanged otherwise.
   */
  private async ensureFiles(v: ModVersion, ctx: GameContext): Promise<ModVersion> {
    if (v.files.length || v.ref.source === 'local') return v;
    const remote = await this.sources
      .provider(ctx)
      .versions(v.ref, ctx)
      .catch(() => [] as ModVersion[]);
    const withFiles = remote.filter((x) => x.files.length);
    const match =
      withFiles.find((x) => x.versionId === v.versionId) ??
      withFiles.find((x) => x.version === v.version) ??
      [...withFiles].filter((x) => !x.optional).sort((a, b) => Date.parse(b.published) - Date.parse(a.published))[0];
    return match ? { ...v, versionId: match.versionId, files: match.files, deps: v.deps.length ? v.deps : match.deps } : v;
  }

  private primaryFiles(v: ModVersion): ModFile[] {
    const primary = v.files.filter((f) => f.primary);
    return primary.length ? primary.slice(0, 1) : v.files.slice(0, 1);
  }

  /**
   * Downloads a plan's files and returns the FOMOD installers that still need
   * the user's choices. The plan applies once they are answered.
   */
  async inspectPlan(planId: string): Promise<FomodPrompt[]> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(t('План устарел, постройте его заново'));
    const profile = this.profile(plan.profileId);
    const def = this.defOf(this.game(profile.gameId));
    if (def.kind !== 'generic') return [];
    const { state, active } = await this.fileState(profile);
    const prompts: FomodPrompt[] = [];
    await Promise.all(
      [...plan.install, ...plan.update].map(async (it) => {
        it.version = await this.ensureFiles(it.version, profile.context);
        const files = this.primaryFiles(it.version);
        if (files.length !== 1 || files[0].url.startsWith(STAGED_PREFIX)) return;
        const file = await this.fetchFile(files[0], it.title, profile.gameId);
        const config = await inspectFomod(file).catch(() => null);
        if (!config) return;
        const known = it.choices && validateChoices(config, it.choices, state).length === 0 ? it.choices : undefined;
        if (known) return;
        prompts.push({ key: it.key, title: it.title, config, choices: it.choices ?? defaultChoices(config, state), activePlugins: active });
      }),
    );
    return prompts;
  }

  async applyPlan(planId: string, force = false, choices: Record<string, FomodChoices> = {}): Promise<{ applied: number; warnings: string[] }> {
    const plan = this.plans.get(planId);
    if (!plan) throw new Error(t('План устарел, постройте его заново'));
    if (!plan.ok && !force) throw new Error(t('В плане есть ошибки совместимости'));
    const profile = this.profile(plan.profileId);
    const game = this.game(profile.gameId);
    const def = this.defOf(game);
    const items: PlanItem[] = [...plan.install, ...plan.update];
    const before = items.length || plan.collectionIds.length ? this.snapshot(profile.id, t('Перед: {0}', plan.label)) : null;

    const staged = new Map<string, { path: string; files: ModFile[]; choices?: FomodChoices }>();
    const warnings: string[] = [];
    const failures: string[] = [];
    this.busy++;
    const fs0 = def.kind === 'generic' ? await this.fileState(profile) : null;
    await Promise.all(
      items.map(async (it) => {
        try {
          it.version = await this.ensureFiles(it.version, profile.context);
          const files = this.primaryFiles(it.version);
          if (files.length === 0) throw new Error(t('у версии нет файлов, а в источнике она не нашлась'));
          const paths = await Promise.all(files.map((f) => this.fetchFile(f, it.title, game.id)));
          const root = this.dir('staging', game.id);
          const version = { ...it.version, files };
          let res;
          try {
            res = await stageVersion(def, version, paths, root, { choices: choices[it.key] ?? it.choices, fileState: fs0?.state });
          } catch (e) {
            if (!(e instanceof FomodRequired)) throw e;
            // Nobody answered the installer (scripted install): take its defaults, say so.
            res = await stageVersion(def, version, paths, root, { choices: defaultChoices(e.config, fs0?.state), fileState: fs0?.state });
            warnings.push(t('«{0}»: установщик FOMOD пройден с вариантами по умолчанию — их можно изменить в карточке мода', it.title));
          }
          forgetStaged(res.stagedPath);
          warnings.push(...res.warnings.map((w) => `«${it.title}»: ${w}`));
          staged.set(it.key, { path: res.stagedPath, files, choices: res.choices });
        } catch (e) {
          failures.push(`«${it.title}»: ${(e as Error).message}`);
        }
      }),
    );
    this.busy--;
    if (failures.length) {
      // nothing was installed: the copies prepared on this attempt go; downloads wait while the plan is open
      for (const st of staged.values()) {
        const used = this.store.state.profiles.some((p) => Object.values(p.mods).some((m) => m.stagedPath === st.path));
        if (!used) await fs.rm(st.path, { recursive: true, force: true }).catch(() => undefined);
      }
      throw new Error(t('Не удалось установить:\n{0}', failures.join('\n')));
    }

    const now = new Date().toISOString();
    const toInstalled = (it: PlanItem, old?: InstalledMod): InstalledMod => ({
      key: it.key,
      ref: it.version.ref,
      title: it.title,
      author: it.author ?? old?.author,
      iconUrl: it.iconUrl ?? old?.iconUrl,
      versionId: it.version.versionId,
      version: it.version.version,
      gameVersions: it.version.gameVersions,
      loaders: it.version.loaders,
      enabled: old ? old.enabled || plan.install.includes(it) : true,
      reason: old && old.reason === 'explicit' ? 'explicit' : it.reason,
      requiredBy: [...new Set([...(old?.requiredBy ?? []), ...it.requiredBy])],
      deps: [...it.version.deps, ...(old?.deps.filter((d) => d.user) ?? [])],
      provides: it.version.provides,
      files: staged.get(it.key)!.files,
      stagedPath: staged.get(it.key)!.path,
      installedAt: now,
      choices: staged.get(it.key)!.choices,
    });
    for (const it of plan.install) profile.mods[it.key] = toInstalled(it, profile.mods[it.key]);
    for (const it of plan.update) profile.mods[it.key] = { ...toInstalled(it, profile.mods[it.key]), enabled: profile.mods[it.key]?.enabled ?? true };

    for (const cid of plan.collectionIds) {
      const c = this.store.state.collections.find((x) => x.id === cid);
      if (!c) continue;
      if (!profile.collections.includes(cid)) profile.collections.push(cid);
      for (const r of c.rules) if (!profile.rules.some((x) => sameRule(x, r))) profile.rules.push(r);
      for (const m of c.mods) {
        const inst = profile.mods[keyOf(m.ref)];
        if (inst && !inst.requiredBy.includes(`collection:${cid}`)) inst.requiredBy.push(`collection:${cid}`);
      }
    }
    recomputeLinks(profile);
    this.changed();
    if (warnings.length) this.toast('info', warnings.slice(0, 3).join('\n'));
    this.toast(
      'ok',
      items.length ? t('{0} — готово, изменено модов: {1}', plan.label, items.length) : t('{0} — готово', plan.label),
      before ? { label: t('Откатить'), snapshotId: before.id } : undefined,
    );
    this.plans.delete(planId);
    this.tidy();
    await this.redeploy(profile.id);
    if (game.activeProfileId !== profile.id && items.length) {
      this.toast('info', t('Профиль «{0}» готов. Переключитесь на него в шапке, когда будете готовы: Lattice разложит его моды в игру.', profile.name));
    }
    return { applied: items.length, warnings };
  }

  // ---------- mods

  async setEnabled(profileId: string, key: string, enabled: boolean) {
    const p = this.profile(profileId);
    const m = p.mods[key];
    if (!m) throw new Error(t('Мод не найден'));
    m.enabled = enabled;
    this.changed();
    await this.redeploy(profileId);
  }

  /** Mods that need `key` (directly) and are enabled. */
  dependentsOf(profileId: string, key: string): string[] {
    const p = this.profile(profileId);
    const target = p.mods[key];
    if (!target) return [];
    const satisfied = new Set([key, ...(target.provides ?? [])]);
    return Object.values(p.mods)
      .filter((m) => m.enabled && m.key !== key && m.deps.some((d) => d.kind === 'requires' && satisfied.has(keyOf(d.ref))))
      .filter((m) => {
        // still satisfied by another provider? then not a real dependent
        const others = providerIndex(Object.values(p.mods).filter((x) => x.enabled && x.key !== key));
        return m.deps.some((d) => d.kind === 'requires' && satisfied.has(keyOf(d.ref)) && !(others.get(keyOf(d.ref)) ?? []).length);
      })
      .map((m) => m.key);
  }

  async removeMod(profileId: string, key: string, cascade = false): Promise<{ removed: string[]; blockedBy: string[] }> {
    const r = await this.removeMods(profileId, [key], { withDeps: true, withDependents: cascade });
    return { removed: r.removed, blockedBy: r.blockedBy };
  }

  /** What a removal would take with it, for the confirmation dialog. */
  previewRemoval(profileId: string, keys: string[], opts: RemovalOptions) {
    const p = this.profile(profileId);
    const plan = planRemoval(p, keys, opts);
    const t = (k: string) => ({ key: k, title: p.mods[k]?.title ?? k });
    return { remove: plan.remove.map(t), dependents: plan.dependents.map(t), deps: plan.deps.map(t) };
  }

  /**
   * Removes mods. Blocked while enabled mods depend on them, unless those go too.
   * With `thorough`, also returns what the mods left behind (staged copies,
   * downloads, settings files) for the user to confirm; nothing more is deleted yet.
   */
  async removeMods(
    profileId: string,
    keys: string[],
    opts: RemovalOptions & { thorough?: boolean },
  ): Promise<{ removed: string[]; blockedBy: string[]; leftovers: Leftover[] }> {
    const p = this.profile(profileId);
    const plan = planRemoval(p, keys, opts);
    if (plan.dependents.length && !opts.withDependents) return { removed: [], blockedBy: plan.dependents, leftovers: [] };
    if (plan.remove.length === 0) return { removed: [], blockedBy: [], leftovers: [] };
    this.snapshot(profileId, plan.remove.length === 1 ? t('Перед удалением «{0}»', p.mods[plan.remove[0]].title) : t('Перед удалением модов ({0})', plan.remove.length));
    const gone = [...plan.remove, ...(opts.withDeps ? plan.deps : [])].map((k) => p.mods[k]).filter(Boolean);
    applyRemoval(p, plan, opts);
    this.changed();
    await this.redeploy(profileId);
    const leftovers = opts.thorough ? await this.findLeftovers(p.gameId, gone) : [];
    if (!opts.thorough) this.tidy();
    return { removed: gone.map((m) => m.key), blockedBy: [], leftovers };
  }

  /** Every mod of the profile, with everything that came with them. */
  removeAllMods(profileId: string, thorough = false) {
    return this.removeMods(profileId, Object.keys(this.profile(profileId).mods), { withDeps: true, withDependents: true, thorough });
  }

  private pendingLeftovers = new Map<string, number>();

  private async findLeftovers(gameId: string, mods: InstalledMod[]): Promise<Leftover[]> {
    const game = this.game(gameId);
    // whatever any profile still uses stays
    const inUse = new Set<string>();
    for (const prof of this.store.state.profiles) {
      for (const m of Object.values(prof.mods)) {
        if (m.stagedPath) inUse.add(path.resolve(m.stagedPath).toLowerCase());
        for (const f of m.files) if (/^https?:|^nexus:/.test(f.url)) inUse.add(path.resolve(path.dirname(this.cachePath(f))).toLowerCase());
      }
    }
    const list = await scanLeftovers({
      mods,
      def: this.defOf(game),
      installPath: game.installPath,
      stagingRoot: this.dir('staging', game.id),
      cachePathOf: (f) => this.cachePath(f),
      inUse,
      owned: await ownedFiles(this.dir('deploy', game.id, 'manifest.json'), this.deployRoot(game)),
    });
    this.pendingLeftovers = new Map(list.map((l) => [path.resolve(l.path).toLowerCase(), l.size]));
    return list;
  }

  /** Deletes the leftovers the user confirmed; only paths from the last scan are accepted. */
  async deleteLeftovers(paths: string[]): Promise<{ deleted: number; freed: number }> {
    let deleted = 0;
    let freed = 0;
    for (const p of paths) {
      const k = path.resolve(p).toLowerCase();
      const size = this.pendingLeftovers.get(k);
      if (size === undefined) continue;
      await fs.rm(p, { recursive: true, force: true });
      this.pendingLeftovers.delete(k);
      deleted++;
      freed += size;
    }
    return { deleted, freed };
  }

  async addRule(profileId: string, rule: OrderRule) {
    const p = this.profile(profileId);
    p.rules = p.rules.filter((r) => !(r.subject === rule.subject && r.other === rule.other) && !(r.subject === rule.other && r.other === rule.subject));
    p.rules.push(rule);
    this.changed();
    await this.redeploy(profileId);
  }

  async removeRule(profileId: string, rule: OrderRule) {
    const p = this.profile(profileId);
    p.rules = p.rules.filter((r) => !sameRule(r, rule));
    this.changed();
    await this.redeploy(profileId);
  }

  /** User-declared link between two installed mods (kept across updates). */
  setUserLink(profileId: string, key: string, dep: DepDecl | null, removeKey?: string) {
    const p = this.profile(profileId);
    const m = p.mods[key];
    if (!m) throw new Error(t('Мод не найден'));
    if (removeKey) m.deps = m.deps.filter((d) => !(d.user && keyOf(d.ref) === removeKey));
    if (dep) {
      m.deps = m.deps.filter((d) => !(d.user && keyOf(d.ref) === keyOf(dep.ref)));
      m.deps.push({ ...dep, user: true });
    }
    recomputeLinks(p);
    this.changed();
  }

  async importLocal(profileId: string, paths: string[]): Promise<InstallPlan> {
    const requests: PlanRequest[] = [];
    for (const p of paths) {
      const st = await fs.stat(p);
      const base = path.basename(p);
      const title = st.isDirectory() ? base : base.replace(/\.[^.]+$/, '');
      const projectId = slugId(title, p);
      const ref: ModRef = { source: 'local', projectId };
      const versionId = createHash('sha1').update(`${p}:${st.mtimeMs}:${st.size}`).digest('hex').slice(0, 12);
      const version = /(\d+\.\d+(?:\.\d+)?)/.exec(title)?.[1] ?? '1.0';
      const v: ModVersion = {
        ref,
        versionId,
        version,
        gameVersions: [],
        loaders: [],
        published: new Date(st.mtimeMs).toISOString(),
        files: [{ url: pathToFileURL(p).href, filename: base, size: st.isDirectory() ? undefined : st.size, hashes: {}, primary: true }],
        deps: [],
      };
      const k = keyOf(ref);
      const entry = this.store.state.local[k] ?? { title, versions: [] };
      entry.versions = [v, ...entry.versions.filter((x) => x.versionId !== versionId)];
      this.store.state.local[k] = entry;
      requests.push({ ref, versionId, title });
    }
    this.store.save();
    return this.planInstall(profileId, requests, { label: paths.length === 1 ? t('Локальный мод «{0}»', requests[0].title) : t('Локальные моды ({0})', paths.length) });
  }

  // ---------- collections

  createCollection(profileId: string, meta: CollectionMeta): Collection {
    const p = this.profile(profileId);
    const c = fromProfile(p, meta, this.store.state.collections);
    this.store.state.collections.push(c);
    this.changed();
    return c;
  }

  updateCollection(id: string, patch: Partial<Pick<Collection, 'name' | 'version' | 'description' | 'author' | 'requires' | 'conflicts'>>) {
    const c = this.store.state.collections.find((x) => x.id === id);
    if (!c) throw new Error(t('Коллекция не найдена'));
    if (patch.requires?.some((l) => l.collectionId === id) || patch.conflicts?.some((l) => l.collectionId === id)) throw new Error(t('Коллекция не может ссылаться на саму себя'));
    Object.assign(c, patch);
    if (patch.requires) {
      for (const l of patch.requires) {
        const cyc = collectionClosure(l.collectionId, this.store.state.collections).order.some((x) => x.id === id);
        if (cyc) throw new Error(t('Получилась циклическая цепочка коллекций'));
      }
    }
    this.changed();
  }

  /** Re-locks a collection from the profile's current state (new version). */
  relockCollection(id: string, profileId: string, version: string) {
    const c = this.store.state.collections.find((x) => x.id === id);
    if (!c) throw new Error(t('Коллекция не найдена'));
    const fresh = fromProfile(this.profile(profileId), { ...c, version }, this.store.state.collections.filter((x) => x.id !== id));
    Object.assign(c, { mods: fresh.mods, rules: fresh.rules, game: fresh.game, version, createdAt: fresh.createdAt });
    this.changed();
  }

  deleteCollection(id: string) {
    const s = this.store.state;
    const users = s.collections.filter((c) => c.requires.some((r) => r.collectionId === id));
    if (users.length) throw new Error(t('На неё ссылаются: {0}', users.map((u) => `«${u.name}»`).join(', ')));
    s.collections = s.collections.filter((c) => c.id !== id);
    for (const p of s.profiles) p.collections = p.collections.filter((x) => x !== id);
    this.changed();
    this.tidy();
  }

  async exportCollection(id: string, file: string) {
    const c = this.store.state.collections.find((x) => x.id === id);
    if (!c) throw new Error(t('Коллекция не найдена'));
    await fs.writeFile(file, JSON.stringify(c, null, 2));
    this.toast('ok', t('Коллекция сохранена: {0}', path.basename(file)));
  }

  /** Whether CurseForge can be used for a game: there is a key and CurseForge has the game. */
  async curseforgeAvailable(defId?: string): Promise<boolean> {
    if (!this.sources.curseforge.available()) return false;
    if (!defId || defId === 'minecraft') return true;
    return (await this.sources.curseforge.gameIdFor(defId).catch(() => null)) !== null;
  }

  /** Tries a CurseForge key before it is saved: how many games it opens. */
  async curseforgeCheck(key: string): Promise<{ games: number }> {
    return { games: await new CurseForgeSource(() => key.trim()).check() };
  }

  /** The user's Modrinth collections (and follows, with a token). */
  modrinthAccount() {
    return this.sources.modrinth.account(this.settings.modrinthUser);
  }

  modrinthList(list: { collection: string } | { follows: true }) {
    return this.sources.modrinth.listProjects(list);
  }

  // ---------- launcher chosen by hand

  /** The executable that starts this game (a launcher for Minecraft); null goes back to automatic. */
  async setLauncherExe(gameId: string, exe: string | null) {
    const game = this.game(gameId);
    const def = this.defOf(game);
    if (!exe) {
      game.install = (await inspectFolder(game.defId, game.installPath, this.env, (await findMinecraftLauncher()) ?? undefined)).install;
      this.changed();
      return;
    }
    const st = await fs.stat(exe).catch(() => null);
    if (!st?.isFile() || !/\.exe$/i.test(exe)) throw new Error(t('Выберите файл .exe лаунчера или игры'));
    const info = await this.installInfo(game);
    const n = path.basename(exe).toLowerCase();
    const guess = /prism/.test(n) ? 'prism' : /multimc/.test(n) ? 'multimc' : /legacy/.test(n) ? 'legacy' : /tlauncher/.test(n) ? 'tlauncher' : /curseforge/.test(n) ? 'curseforge' : /modrinth/.test(n) ? 'modrinth' : /atlauncher/.test(n) ? 'atlauncher' : /^minecraft(launcher)?\.exe$/.test(n) ? 'official' : undefined;
    game.install = { ...info, launcherExe: path.resolve(exe), customExe: true, ...(def.kind === 'minecraft' ? { launcher: guess ?? info.launcher ?? 'other' } : {}) };
    this.changed();
  }

  // ---------- disk: nothing Lattice downloaded or prepared stays without a reason

  /** operations that are writing to the cache right now; cleaning waits for them */
  private busy = 0;

  /** Folders of the cache that profiles and open plans use (`live`) and that only snapshots keep (`snap`). */
  private usedPaths() {
    const norm = (p: string) => path.resolve(p).toLowerCase();
    const live = new Set<string>();
    const snap = new Set<string>();
    const keep = (set: Set<string>, m: { stagedPath?: string; files: ModFile[] }) => {
      if (m.stagedPath) set.add(norm(m.stagedPath));
      for (const f of m.files) if (/^https?:|^nexus:/.test(f.url)) set.add(norm(path.dirname(this.cachePath(f))));
    };
    for (const m of this.store.state.profiles.flatMap((p) => Object.values(p.mods))) keep(live, m);
    // a plan still on screen keeps what it has downloaded, so trying again does not download again
    for (const plan of this.plans.values()) for (const it of [...plan.install, ...plan.update]) keep(live, { files: it.version.files });
    for (const m of this.store.state.snapshots.flatMap((s) => Object.values(s.mods))) keep(snap, m);
    return { live, snap, norm };
  }

  /** Prepared copies and downloaded files no profile or open plan uses: kept only by snapshots, or by nothing. */
  private async cacheEntries(): Promise<{ path: string; size: number; kind: 'unused' | 'snapshot' }[]> {
    const { live, snap, norm } = this.usedPaths();
    const active = new Set(this.downloads.list().filter((d) => !['done', 'error', 'cancelled'].includes(d.state)).map((d) => d.filename.toLowerCase()));
    const out: { path: string; size: number; kind: 'unused' | 'snapshot' }[] = [];
    const add = async (p: string) => {
      const k = norm(p);
      if (!live.has(k)) out.push({ path: p, size: await dirSize(p), kind: snap.has(k) ? 'snapshot' : 'unused' });
    };
    const dirsOf = async (p: string) => (await fs.readdir(p, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => path.join(p, e.name));
    const stagingRoot = this.dir('staging');
    for (const gameDir of await dirsOf(stagingRoot)) {
      const base = path.basename(gameDir);
      if (base === '_shared') continue; // modpack files collections point to
      if (base === '_import') {
        out.push({ path: gameDir, size: await dirSize(gameDir), kind: 'unused' }); // leftovers of unpacked modpacks
        continue;
      }
      for (const modDir of await dirsOf(gameDir)) for (const verDir of await dirsOf(modDir)) await add(verDir);
    }
    for (const a of await dirsOf(this.dir('downloads'))) {
      for (const b of await dirsOf(a)) {
        const files = await fs.readdir(b).catch(() => [] as string[]);
        if (files.some((f) => active.has(f.replace(/\.part$/, '').toLowerCase()))) continue;
        await add(b);
      }
    }
    return out;
  }

  private async unusedEntries() {
    return (await this.cacheEntries()).filter((e) => e.kind === 'unused');
  }

  /** How much space Lattice takes, how much only snapshots keep, and how much nothing needs. */
  async diskUsage(): Promise<{ downloads: number; staging: number; unused: number; unusedCount: number; snapshots: number; snapshotCount: number; quarantine: number; quarantinePath: string }> {
    const all = await this.cacheEntries();
    const sum = (k: 'unused' | 'snapshot') => all.filter((e) => e.kind === k).reduce((a, x) => a + x.size, 0);
    return {
      downloads: await dirSize(this.dir('downloads')),
      staging: await dirSize(this.dir('staging')),
      unused: sum('unused'),
      unusedCount: all.filter((e) => e.kind === 'unused').length,
      snapshots: sum('snapshot'),
      snapshotCount: this.store.state.snapshots.length,
      quarantine: await dirSize(this.dir('quarantine')),
      quarantinePath: this.dir('quarantine'),
    };
  }

  /** At start: what a crash or a quick exit left behind, and quarantine older than a week. */
  async cleanupOnStart() {
    if (this.trimSnapshots() > 0) this.changed();
    const week = Date.now() - 7 * 24 * 3600 * 1000;
    for (const e of await fs.readdir(this.dir('quarantine'), { withFileTypes: true }).catch(() => [])) {
      const born = Number(e.name.split('-')[0]);
      if (e.isDirectory() && Number.isFinite(born) && born < week) await fs.rm(this.dir('quarantine', e.name), { recursive: true, force: true }).catch(() => undefined);
    }
    if (!(await fs.readdir(this.dir('quarantine')).catch(() => ['x'])).length) await fs.rmdir(this.dir('quarantine')).catch(() => undefined);
    await this.freeUnused().catch(() => undefined);
  }

  /** Deletes what nothing needs; empty mod folders go too. */
  async freeUnused(): Promise<{ removed: number; freed: number }> {
    if (this.busy > 0) return { removed: 0, freed: 0 };
    let removed = 0;
    let freed = 0;
    for (const e of await this.unusedEntries()) {
      await fs.rm(e.path, { recursive: true, force: true }).then(
        () => {
          removed++;
          freed += e.size;
        },
        () => undefined,
      );
      const parent = path.dirname(e.path);
      if (!(await fs.readdir(parent).catch(() => ['x'])).length) await fs.rmdir(parent).catch(() => undefined);
    }
    return { removed, freed };
  }

  /** Cleaning after an operation, without bothering the user. */
  private tidy() {
    setTimeout(() => void this.freeUnused().catch(() => undefined), 500);
  }

  /** A plan that was closed without applying: what it downloaded is no longer kept for it. */
  discardPlan(planId: string) {
    if (this.plans.delete(planId)) this.tidy();
  }

  // ---------- moving over from other managers

  private importScan = new Map<string, ImportSource>();

  /** Vortex, Mod Organizer 2 and r2modman setups of this game found on the computer. */
  async scanImports(gameId: string) {
    const game = this.game(gameId);
    const copies = await this.detectGames().catch(() => [] as { defId: string; path: string }[]);
    const dirs = [...this.store.state.games.map((g) => ({ defId: g.defId, path: g.installPath })), ...copies.map((c) => ({ defId: c.defId, path: c.path }))];
    const all = await scanManagers(this.env, dirs);
    for (const s of all) this.importScan.set(s.id, s);
    return all
      .filter((s) => s.defId === game.defId)
      .map((s) => ({
        id: s.id,
        manager: s.manager,
        path: s.path,
        deployedFiles: s.deployedFiles ?? 0,
        profiles: s.profiles.map((p) => ({
          id: p.id,
          name: p.name,
          count: p.mods.filter((m) => m.enabled).length,
          known: p.mods.filter((m) => m.enabled && (m.nexus || m.thunderstore)).length,
          skipped: p.mods.filter((m) => m.enabled && m.problem).map((m) => ({ name: m.name, problem: m.problem! })),
        })),
      }));
  }

  /**
   * Takes one profile of another manager into a new Lattice profile. Vortex and
   * MO2 mods come from their folders (nothing is downloaded again) and are
   * matched with Nexus; r2modman mods come from Thunderstore in the same
   * versions. The result is a plan: missing dependencies and conflicts show up
   * before anything is installed.
   */
  async importPlan(gameId: string, sourceId: string, profileId: string, name: string): Promise<InstallPlan> {
    const game = this.game(gameId);
    const def = this.defOf(game);
    const src = this.importScan.get(sourceId);
    const prof = src?.profiles.find((p) => p.id === profileId);
    if (!src || !prof) throw new Error(t('Список модов устарел — откройте перенос заново'));
    const managerName = { vortex: 'Vortex', mo2: 'Mod Organizer 2', r2modman: 'r2modman' }[src.manager];
    const target = this.createProfile(game.id, name || `${managerName} · ${prof.name}`);
    const label = t('Перенос из {0}: «{1}»', managerName, target.name);

    if (src.manager === 'r2modman') {
      const requests: PlanRequest[] = prof.mods
        .filter((m) => m.enabled && m.thunderstore)
        .map((m) => ({ ref: { source: 'thunderstore', projectId: m.thunderstore!.fullName }, versionId: `${m.thunderstore!.fullName}-${m.thunderstore!.version}`, title: m.name }));
      return this.planInstall(target.id, requests, { label });
    }

    const domain = def.nexusDomain;
    const usable = prof.mods.filter((m) => m.dir && !m.problem);
    const mods: CollectionMod[] = [];
    const keyByName = new Map<string, string>();
    await mapPool(usable, 6, async (m) => {
      const file: ModFile = { url: pathToFileURL(m.dir!).href, filename: path.basename(m.dir!), hashes: {}, primary: true, targetPath: m.prefix || undefined };
      let version: ModVersion | undefined;
      if (m.nexus && domain) {
        const vs = await this.sources.nexus.versions({ source: 'nexus', projectId: `${domain}/${m.nexus.modId}` }).catch(() => [] as ModVersion[]);
        const stem = (f?: string) => (f ?? '').replace(/\.(zip|7z|rar)$/i, '').toLowerCase();
        const uploaded = m.nexus.uploaded ? new Date(m.nexus.uploaded * 1000).toISOString() : '';
        version =
          vs.find((v) => m.nexus!.fileId && v.versionId === String(m.nexus!.fileId)) ??
          vs.find((v) => uploaded && v.published === uploaded) ??
          vs.find((v) => m.folder && stem(v.files[0]?.filename) === m.folder.replace(/\.\d+$/, '').toLowerCase()) ??
          vs.find((v) => m.nexus!.version && v.version === m.nexus!.version);
      }
      if (version) {
        mods.push({ ref: version.ref, title: m.name, versionId: version.versionId, version: version.version, optional: !m.enabled, files: [file], deps: version.deps, gameVersions: [], loaders: [] });
        keyByName.set(m.folder ?? m.name, keyOf(version.ref));
        return;
      }
      // a mod no source knows: kept as a local mod
      const ref: ModRef = { source: 'local', projectId: slugId(m.name, `${src.id}/${m.dir}`) };
      const v: ModVersion = { ref, versionId: createHash('sha1').update(m.dir!).digest('hex').slice(0, 12), version: m.nexus?.version ?? '—', gameVersions: [], loaders: [], published: new Date().toISOString(), files: [file], deps: [] };
      this.store.state.local[keyOf(ref)] = { title: m.name, versions: [v] };
      mods.push({ ref, title: m.name, versionId: v.versionId, version: v.version, optional: !m.enabled, files: [file], deps: [], gameVersions: [], loaders: [] });
      keyByName.set(m.folder ?? m.name, keyOf(ref));
    });

    // who wins a file several mods have: as the other manager had it (Vortex) or by priority (MO2)
    const owners = new Map<string, string[]>();
    for (const m of usable) {
      const k = keyByName.get(m.folder ?? m.name);
      if (!k) continue;
      for (const rel of await walk(m.dir!).catch(() => [] as string[])) {
        const at = path.posix.join(m.prefix ?? '', rel).toLowerCase();
        owners.set(at, [...(owners.get(at) ?? []), k]);
      }
    }
    const prio = new Map(usable.map((m) => [keyByName.get(m.folder ?? m.name), m.priority]));
    const byFolder = new Map(usable.map((m) => [m.folder ?? m.name, keyByName.get(m.folder ?? m.name)]));
    const rules: OrderRule[] = [];
    const seen = new Set<string>();
    for (const [rel, keys] of owners) {
      if (keys.length < 2) continue;
      const won = prof.winners?.[rel] ? byFolder.get(prof.winners[rel]) : undefined;
      const winner = won && keys.includes(won) ? won : [...keys].sort((a, b) => (prio.get(b) ?? 0) - (prio.get(a) ?? 0))[0];
      for (const other of keys) {
        if (other === winner || seen.has(`${winner}|${other}`)) continue;
        seen.add(`${winner}|${other}`);
        rules.push({ subject: winner, kind: 'after', other });
      }
    }

    const c: Collection = {
      schema: 'lattice.collection/1',
      id: slugId(`${managerName} ${prof.name}`, `${src.id}/${prof.id}/${Date.now()}`),
      name: `${managerName} · ${target.name}`,
      version: '1.0.0',
      author: '',
      description: t('Перенесено из {0}: {1}', managerName, src.path),
      game: { defId: def.id },
      requires: [],
      conflicts: [],
      mods,
      rules,
      createdAt: new Date().toISOString(),
      importedFrom: src.path,
    };
    this.upsertCollection(c);
    return this.planCollection(target.id, c.id);
  }

  /** The profile as a collection file: exact versions, hashes, rules and installer options. */
  async exportProfile(profileId: string, file: string) {
    const p = this.profile(profileId);
    const game = this.game(p.gameId);
    const c = fromProfile(p, { name: p.name, version: '1.0.0', author: '', description: t('Профиль «{0}» ({1})', p.name, game.name) }, this.store.state.collections);
    await fs.writeFile(file, JSON.stringify(c, null, 2));
    this.toast('ok', t('Профиль сохранён: {0}', path.basename(file)));
  }

  /** Games, profiles, collections, snapshots and settings in one file; no keys, no mod files. */
  async backupAll(file: string): Promise<{ games: number; profiles: number; collections: number }> {
    const st = this.state();
    const { nexusUser: _u, githubToken: _g, ...settings } = st.settings;
    const games = st.games.map(({ install: _i, ...g }) => g);
    const doc = { schema: 'lattice.backup/1', app: APP_VERSION, createdAt: new Date().toISOString(), state: { ...st, games, settings, local: this.store.state.local } };
    await fs.writeFile(file, JSON.stringify(doc, null, 1));
    return { games: games.length, profiles: st.profiles.length, collections: st.collections.length };
  }

  /**
   * Replaces games, profiles, collections and snapshots with a backup. The
   * current state is kept as state.json.before-restore; keys stay as they are,
   * launchers are looked up again, missing mod files are fetched by the health check.
   */
  async restoreBackup(file: string): Promise<{ games: number; profiles: number }> {
    let doc: { schema?: string; state?: Partial<Persisted> } | null = null;
    try {
      doc = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      doc = null;
    }
    const s = doc?.state;
    if (doc?.schema !== 'lattice.backup/1' || !s || !Array.isArray(s.games) || !Array.isArray(s.profiles)) throw new Error(t('Это не резервная копия Lattice'));
    await this.store.keepCopy('.before-restore');
    const cur = this.store.state;
    const games = s.games.filter((g) => g && typeof g.id === 'string' && gameDef(g.defId)).map(({ install: _i, ...g }) => g as ManagedGame);
    const ids = new Set(games.map((g) => g.id));
    cur.games = games;
    cur.profiles = s.profiles.filter((p) => p && ids.has(p.gameId));
    const profileIds = new Set(cur.profiles.map((p) => p.id));
    cur.collections = Array.isArray(s.collections) ? s.collections : [];
    cur.snapshots = (Array.isArray(s.snapshots) ? s.snapshots : []).filter((x) => profileIds.has(x.profileId));
    cur.activeGameId = s.activeGameId && ids.has(s.activeGameId) ? s.activeGameId : games[0]?.id;
    cur.local = { ...cur.local, ...(s.local ?? {}) };
    for (const g of games) if (!profileIds.has(g.activeProfileId)) g.activeProfileId = cur.profiles.find((p) => p.gameId === g.id)?.id ?? g.activeProfileId;
    const b = (s.settings ?? {}) as Partial<Settings>;
    // only plain preferences come from the file; keys, trusted hosts and the data folder stay
    const prefs: Partial<Settings> = {};
    for (const k of ['theme', 'maxParallelDownloads', 'maxConnectionsPerFile', 'minSegmentMiB', 'deployMethod', 'enabledSources', 'includeRecommended', 'language'] as const) {
      if (b[k] !== undefined) (prefs as Record<string, unknown>)[k] = b[k];
    }
    cur.settings = { ...defaultSettings(cur.settings.dataRoot), ...cur.settings };
    this.updateSettings(prefs);
    this.changed();
    return { games: cur.games.length, profiles: cur.profiles.length };
  }

  async importCollectionFile(file: string): Promise<Collection> {
    const c = /\.mrpack$/i.test(file)
      ? await importMrpack(file, this.sources.modrinth, this.dir('staging', '_shared'))
      : parseCollection(await fs.readFile(file, 'utf8'));
    this.upsertCollection(c);
    return c;
  }

  private upsertCollection(c: Collection) {
    const s = this.store.state;
    s.collections = [...s.collections.filter((x) => x.id !== c.id), c];
    this.changed();
    this.toast('ok', t('Коллекция «{0}» добавлена в библиотеку', c.name));
  }

  /** Downloads a Modrinth modpack and turns it into a collection. */
  async importModpack(ref: ModRef): Promise<Collection> {
    if (ref.source === 'nexus' && ref.projectId.startsWith('collection/')) return this.importNexusCollection(ref.projectId.slice('collection/'.length));
    const versions = await this.sources.modrinth.versions(ref, { gameDefId: 'minecraft' });
    const v = versions.sort((a, b) => Date.parse(b.published) - Date.parse(a.published))[0];
    if (!v) throw new Error(t('У сборки нет версий'));
    const f = v.files.find((x) => x.primary) ?? v.files[0];
    const file = await this.fetchFile(f, t('Сборка {0}', v.name ?? v.version), this.store.state.activeGameId);
    const c = await importMrpack(file, this.sources.modrinth, this.dir('staging', '_shared'));
    this.upsertCollection(c);
    return c;
  }

  /**
   * A Nexus collection as a Lattice collection: the exact files of its latest
   * revision, with each mod's Nexus requirements as links, so the plan shows
   * what is missing before anything is installed.
   */
  async importNexusCollection(slug: string): Promise<Collection> {
    const content = await this.sources.nexus.collectionMods(slug);
    const def = GAME_DEFS.find((d) => d.nexusDomain === content.domain);
    if (!def) throw new Error(t('Сборка для игры «{0}» не поддерживается', content.domain));
    const reqs = await this.sources.nexus.requirements(content.domain, content.files.map((f) => f.modId)).catch(() => new Map<number, DepDecl[]>());
    // one entry per mod: its main file wins over optional extras of the same mod
    const byMod = new Map<number, (typeof content.files)[number]>();
    for (const f of content.files) {
      const cur = byMod.get(f.modId);
      if (!cur || (cur.optional && !f.optional)) byMod.set(f.modId, f);
    }
    const mods: CollectionMod[] = [...byMod.values()].map((f) => ({
      ref: { source: 'nexus', projectId: `${content.domain}/${f.modId}` },
      title: f.modName,
      versionId: String(f.fileId),
      version: f.version,
      optional: f.optional,
      files: [{ url: `nexus://${content.domain}/${f.modId}/${f.fileId}`, filename: f.uri, size: f.size, hashes: {}, primary: true }],
      deps: reqs.get(f.modId) ?? [],
      gameVersions: [],
      loaders: [],
    }));
    const c: Collection = {
      schema: 'lattice.collection/1',
      id: slugId(content.name, `nexus:${slug}`),
      name: content.name,
      version: String(content.revision),
      author: content.author,
      description: content.summary,
      game: { defId: def.id },
      requires: [],
      conflicts: [],
      mods,
      rules: [],
      createdAt: new Date().toISOString(),
      importedFrom: `https://www.nexusmods.com/games/${content.domain}/collections/${slug}`,
    };
    this.upsertCollection(c);
    const extra = content.files.length - mods.length;
    if (extra > 0) this.toast('info', t('«{0}»: {1} дополнительных файлов тех же модов не вошли — Lattice ставит по одному файлу на мод.', c.name, extra));
    if (!this.settings.nexusUser?.premium) {
      this.toast('info', t('В сборке «{0}» {1} файлов с Nexus. Без Premium Nexus отдаёт каждый файл только через кнопку на сайте, поэтому большие сборки удобнее ставить с Premium.', c.name, mods.length));
    }
    return c;
  }

  createProfileForCollection(collectionId: string, gameId: string): Profile {
    const c = this.store.state.collections.find((x) => x.id === collectionId);
    if (!c) throw new Error(t('Коллекция не найдена'));
    const p = this.createProfile(gameId, c.name, { gameVersion: c.game.gameVersion, loader: c.game.loader });
    return p;
  }

  async removeCollectionFromProfile(profileId: string, collectionId: string): Promise<string[]> {
    const p = this.profile(profileId);
    const dependents = this.store.state.collections.filter((c) => p.collections.includes(c.id) && c.requires.some((r) => r.collectionId === collectionId));
    if (dependents.length) throw new Error(t('Сначала уберите коллекции, которые на ней строятся: {0}', dependents.map((d) => `«${d.name}»`).join(', ')));
    this.snapshot(profileId, t('Перед удалением коллекции'));
    p.collections = p.collections.filter((x) => x !== collectionId);
    for (const m of Object.values(p.mods)) m.requiredBy = m.requiredBy.filter((r) => r !== `collection:${collectionId}`);
    const removed = collectOrphans(p);
    this.changed();
    await this.redeploy(profileId);
    return removed;
  }

  // ---------- deployment

  private deployRoot(game: ManagedGame) {
    return path.join(game.installPath, this.defOf(game).deployDir);
  }

  /** Absolute paths (lower case) of the files Lattice has placed into a game folder. */
  private async ourFiles(game: ManagedGame): Promise<Set<string>> {
    const root = this.deployRoot(game);
    const rel = await ownedFiles(this.dir('deploy', game.id, 'manifest.json'), root).catch(() => new Set<string>());
    return new Set([...rel].map((r) => path.resolve(root, r).toLowerCase()));
  }

  private deployOptions(p: Profile, game: ManagedGame): DeployOptions {
    return {
      root: this.deployRoot(game),
      order: computeOrder(Object.values(p.mods), p.rules).order,
      mods: p.mods,
      manifestPath: this.dir('deploy', game.id, 'manifest.json'),
      backupDir: this.dir('deploy', game.id, 'backup'),
      method: this.settings.deployMethod,
    };
  }

  /** Re-applies the active profile after a change; a problem becomes a message instead of undoing the change. */
  private async redeploy(profileId: string) {
    const p = this.profile(profileId);
    if (this.game(p.gameId).activeProfileId !== profileId) return;
    await this.deploy(profileId).catch((e) => this.toast('err', (e as Error).message));
  }

  async deploy(profileId: string): Promise<DeployResult> {
    const p = this.profile(profileId);
    const game = this.game(p.gameId);
    if (game.activeProfileId !== profileId) throw new Error(t('Профиль не активен'));
    const st = await fs.stat(game.installPath).catch(() => null);
    if (!st?.isDirectory()) throw new Error(t('Папка игры не найдена: {0}', game.installPath));
    const def = this.defOf(game);
    if (def.kind !== 'minecraft' && Object.values(p.mods).some((m) => m.enabled)) {
      const vortex = await vortexDeployedFiles(game.installPath, def, await this.ourFiles(game)).catch(() => 0);
      if (vortex > 0) throw new Error(t('В папке игры лежат моды, развёрнутые Vortex ({0} файлов). Нажмите Purge в Vortex — или, если Vortex уже удалён, «Проверить целостность» в настройках: Lattice уберёт их сам.', vortex));
    }
    const res = await deploy(this.deployOptions(p, game));
    if (def.pluginsTxt) {
      const plugins = (await this.pluginOrder(profileId)).map((x) => x.name);
      await writePluginsTxt(pluginsTxtPath(this.pluginsFolder(game, def)), this.dir('deploy', game.id), plugins);
    }
    p.deployedAt = new Date().toISOString();
    this.changed();
    const out = { ...res, root: this.deployRoot(game) };
    this.emit('deployed', { profileId, ...out });
    if (res.failed?.length) throw new Error(lockedMessage(res.failed));
    return out;
  }

  /**
   * Starts the game with the active profile's mods: deploys first, then for
   * Minecraft puts the Fabric/Quilt loader into the official launcher and opens
   * it; other games start through Steam or their script extender.
   */
  async launchGame(gameId: string): Promise<{ note: string }> {
    const game = this.game(gameId);
    const def = this.defOf(game);
    const p = this.profile(game.activeProfileId);
    await this.deploy(p.id);
    if (def.kind === 'minecraft') return this.launchMinecraft(game, p);
    const target = await gameLaunchTarget(def, game.installPath, await this.installInfo(game));
    await this.launcher(target);
    if (target.kind === 'steam') return { note: t('Запускаем {0} через Steam', game.name) };
    if (target.kind === 'url') return { note: t('Запускаем {0} через Epic Games', game.name) };
    return { note: t('Запускаем {0}', path.basename(target.path)) };
  }

  /**
   * Minecraft starts through the launcher that owns the folder: Prism and MultiMC
   * start the instance directly, Legacy Launcher starts the chosen version, the
   * official launcher gets a ready profile; Fabric and Quilt are installed first.
   */
  private async launchMinecraft(game: ManagedGame, p: Profile): Promise<{ note: string }> {
    const info = await this.installInfo(game);
    const launcher = info.launcher ?? 'other';
    const name = launcherName(launcher) || t('лаунчер');
    if (launcher === 'prism' || launcher === 'multimc') {
      if (!info.launcherExe || !info.instanceId) return { note: t('Моды уже в папке экземпляра. Запустите его в {0}.', name) };
      await this.launcher({ kind: 'exe', path: info.launcherExe, args: ['--launch', info.instanceId] });
      return { note: t('{0} запускает экземпляр «{1}» с модами профиля.', name, info.instanceId) };
    }
    if (launcher === 'official' || launcher === 'legacy' || launcher === 'tlauncher') {
      if (!p.context.gameVersion) throw new Error(t('Укажите версию Minecraft у профиля (Настройки → профиль), чтобы поставить загрузчик под неё.'));
      let res: { versionId: string; profileName: string };
      try {
        res = await installMinecraftLoader(info.launcherRoot ?? game.installPath, p.context.gameVersion, p.context.loader ?? 'fabric', p.id, p.name, game.installPath);
      } catch (e) {
        // the loader could not be set up: the launcher still opens, the version is picked there
        const exe = info.launcherExe ?? (launcher === 'official' ? await findMinecraftLauncher() : null);
        if (!exe) throw e;
        await this.launcher({ kind: 'exe', path: exe });
        return { note: t('Загрузчик не поставлен: {0} Лаунчер открыт — выберите версию в нём.', (e as Error).message) };
      }
      if (launcher === 'official') {
        const exe = info.launcherExe ?? (await findMinecraftLauncher());
        if (!exe) return { note: t('Профиль «{0}» добавлен в лаунчер Minecraft. Откройте лаунчер, выберите этот профиль и нажмите «Играть».', res.profileName) };
        await this.launcher({ kind: 'exe', path: exe });
        return { note: t('Открываем лаунчер Minecraft: выберите профиль «{0}» и нажмите «Играть».', res.profileName) };
      }
      if (launcher === 'legacy' && info.launcherExe) {
        await this.launcher({ kind: 'exe', path: info.launcherExe, args: ['--version', res.versionId, '--launch'] });
        return { note: t('Legacy Launcher запустит версию {0} через несколько секунд.', res.versionId) };
      }
      if (info.launcherExe) await this.launcher({ kind: 'exe', path: info.launcherExe });
      return { note: t('Версия {0} добавлена в {1}: выберите её в лаунчере и нажмите «Играть».', res.versionId, name) };
    }
    // CurseForge, Modrinth App and ATLauncher keep versions themselves
    if (info.launcherExe) await this.launcher({ kind: 'exe', path: info.launcherExe });
    return { note: t('Моды уже в папке экземпляра. Запустите его в {0}.', name) };
  }

  /** Points a game at a new folder (it was moved); the old folder is cleaned first when it still exists. */
  async setGamePath(gameId: string, installPath: string) {
    const game = this.game(gameId);
    const st = await fs.stat(installPath).catch(() => null);
    if (!st?.isDirectory()) throw new Error(t('Папка не найдена'));
    const found = await inspectFolder(game.defId, installPath, this.env, (await findMinecraftLauncher()) ?? undefined);
    if (await fs.stat(game.installPath).catch(() => null)) await this.purge(gameId);
    game.installPath = found.path;
    game.install = found.install;
    this.changed();
    await this.deploy(game.activeProfileId).catch((e) => this.toast('err', (e as Error).message));
  }

  // ---------- integrity

  /** Problems worth fixing at start: missing files, broken deployment, contradicting rules, half downloads. */
  async healthCheck(): Promise<HealthProblem[]> {
    const out: HealthProblem[] = [];
    if (this.store.recovered) {
      out.push({ id: 'state-recovered', title: t('Файл настроек Lattice был повреждён'), detail: t('Загружена последняя исправная копия. Проверьте, все ли игры и профили на месте.'), fixable: false });
    }
    for (const game of this.store.state.games) {
      if (!(await fs.stat(game.installPath).catch(() => null))?.isDirectory()) {
        out.push({ id: `folder:${game.id}`, title: t('{0}: папка игры не найдена', game.name), detail: t('{0} — игру переместили или удалили. Укажите новую папку в настройках.', game.installPath), fixable: false, gameId: game.id });
        continue;
      }
      const p = this.store.state.profiles.find((x) => x.id === game.activeProfileId);
      if (!p) continue;
      const def = this.defOf(game);
      if (def.kind === 'minecraft') {
        // what the launcher runs in this folder now (the user may have changed it there)
        const now = await inspectFolder(game.defId, game.installPath, this.env, (await findMinecraftLauncher()) ?? undefined).catch(() => null);
        if (now && samePath(now.path, game.installPath)) {
          const merged = game.install?.customExe ? { ...now.install, launcher: game.install.launcher, launcherExe: game.install.launcherExe, customExe: true } : now.install;
          if (JSON.stringify(merged) !== JSON.stringify(game.install)) {
            game.install = merged;
            this.changed();
          }
          const ctx = p.context;
          if (now.gameVersion && (now.gameVersion !== ctx.gameVersion || (now.loader && now.loader !== ctx.loader))) {
            out.push({
              id: `mcver:${p.id}`,
              title: t('{0}: версия экземпляра не совпадает с профилем', game.name),
              detail: t('{0} запускает Minecraft {1} {2}, а профиль Lattice рассчитан на {3} {4}. Lattice возьмёт версию экземпляра и перепроверит моды.', launcherName(now.install.launcher) || t('лаунчер'), now.gameVersion, now.loader ?? '', ctx.gameVersion ?? '—', ctx.loader ?? ''),
              fixable: true,
              profileId: p.id,
            });
          }
        }
      } else {
        if (!game.install) await this.installInfo(game).catch(() => undefined);
        const vortex = await vortexDeployedFiles(game.installPath, def, await this.ourFiles(game)).catch(() => 0);
        if (vortex > 0) {
          out.push({
            id: `vortex:${game.id}`,
            title: t('{0}: в папке игры остались файлы Vortex ({1})', game.name, vortex),
            detail: t('Если вы ещё пользуетесь Vortex, нажмите в нём Purge. Если Vortex удалён, Lattice уберёт эти файлы по его же списку и вернёт оригинальные файлы игры — больше ничего не тронет.'),
            fixable: true,
            gameId: game.id,
          });
        }
      }
      const missing: InstalledMod[] = [];
      for (const m of Object.values(p.mods)) if (!(await fs.stat(m.stagedPath).catch(() => null))) missing.push(m);
      if (missing.length) {
        out.push({
          id: `staging:${p.id}`,
          title: t('{0}: пропали файлы модов ({1})', game.name, missing.length),
          detail: t('{0}{1}. Lattice скачает и подготовит их заново.', missing.slice(0, 4).map((m) => `«${m.title}»`).join(', '), missing.length > 4 ? '…' : ''),
          fixable: true,
          profileId: p.id,
          keys: missing.map((m) => m.key),
        });
      }
      const { cycles } = computeOrder(Object.values(p.mods), p.rules);
      if (cycles.length) {
        out.push({
          id: `cycle:${p.id}`,
          title: t('{0}: правила порядка загрузки противоречат друг другу', game.name),
          detail: cycles.map((c) => c.map((k) => `«${p.mods[k]?.title ?? k}»`).join(' → ')).join('; ') + t('. Lattice уберёт противоречащие правила.'),
          fixable: true,
          profileId: p.id,
        });
      }
      const drift = await deployDrift(this.deployOptions(p, game)).catch(() => ({ missing: [] as string[], stale: [] as string[] }));
      if (p.deployedAt && drift.missing.length) {
        out.push({
          id: `deploy:${p.id}`,
          title: t('{0}: в папке игры не хватает файлов модов ({1})', game.name, drift.missing.length),
          detail: t('Их удалили вручную или игра обновилась. Lattice разложит их заново.'),
          fixable: true,
          profileId: p.id,
        });
      }
      if (drift.stale.length) {
        out.push({
          id: `stale:${p.id}`,
          title: t('{0}: в папке игры остались файлы убранных модов ({1})', game.name, drift.stale.length),
          detail: t('Скорее всего, игра держала их открытыми, когда Lattice их убирал. Например: {0}. Закройте игру — Lattice уберёт их.', drift.stale.slice(0, 3).join(', ')),
          fixable: true,
          profileId: p.id,
        });
      }
    }
    const busy = this.downloads.list().some((d) => ['queued', 'probing', 'downloading', 'paused', 'verifying'].includes(d.state));
    const parts = busy ? [] : (await walk(this.dir('downloads')).catch(() => [] as string[])).filter((r) => r.endsWith('.part'));
    if (parts.length) {
      out.push({ id: 'parts', title: t('Недокачанные файлы в кэше загрузок'), detail: t('{0} шт. остались от прерванных загрузок и только занимают место.', parts.length), fixable: true });
    }
    return out;
  }

  async repair(ids: string[]): Promise<{ fixed: string[]; failed: { id: string; error: string }[] }> {
    const fixed: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const pr of (await this.healthCheck()).filter((x) => ids.includes(x.id) && x.fixable)) {
      try {
        if (pr.id.startsWith('staging:')) await this.restage(pr.profileId!, pr.keys ?? []);
        else if (pr.id.startsWith('cycle:')) {
          const p = this.profile(pr.profileId!);
          const { cycles } = computeOrder(Object.values(p.mods), p.rules);
          const inCycle = cycles.map((c) => new Set(c));
          p.rules = p.rules.filter((r) => !inCycle.some((c) => c.has(r.subject) && c.has(r.other)));
          this.changed();
          await this.deploy(p.id);
        } else if (pr.id.startsWith('deploy:') || pr.id.startsWith('stale:')) await this.deploy(pr.profileId!);
        else if (pr.id.startsWith('vortex:')) {
          const game = this.game(pr.gameId!);
          const r = await removeVortexLeftovers(game.installPath, this.defOf(game), this.dir('quarantine', `${Date.now()}-${game.id}`), await this.ourFiles(game));
          if (r.failed.length) throw new Error(t('Не удалось убрать: {0}. Закройте игру и попробуйте снова.', r.failed.slice(0, 3).join(', ')));
          if (r.removed) this.toast('ok', t('Файлы Vortex ({0}) перенесены в карантин Lattice на 7 дней: Настройки → Обслуживание → «Место на диске».', r.removed));
          await this.redeploy(game.activeProfileId);
        } else if (pr.id.startsWith('mcver:')) {
          const p = this.profile(pr.profileId!);
          const game = this.game(p.gameId);
          const now = await inspectFolder(game.defId, game.installPath, this.env);
          this.updateProfile(p.id, { context: { gameVersion: now.gameVersion, loader: now.loader ?? p.context.loader } });
        }
        else if (pr.id === 'parts') {
          for (const r of (await walk(this.dir('downloads'))).filter((x) => x.endsWith('.part'))) await fs.rm(this.dir('downloads', r), { force: true });
        }
        fixed.push(pr.id);
      } catch (e) {
        failed.push({ id: pr.id, error: (e as Error).message });
      }
    }
    return { fixed, failed };
  }

  /** Downloads and stages mods again whose staged copies are gone. */
  private async restage(profileId: string, keys: string[]) {
    const p = this.profile(profileId);
    const game = this.game(p.gameId);
    const def = this.defOf(game);
    const errors: string[] = [];
    for (const key of keys) {
      const m = p.mods[key];
      if (!m) continue;
      try {
        if (m.files.some((f) => f.url.startsWith(STAGED_PREFIX))) throw new Error(t('файлы сборки можно вернуть только повторным импортом коллекции'));
        const paths = await Promise.all(m.files.map((f) => this.fetchFile(f, m.title, p.gameId)));
        const res = await stageVersion(def, installedVersion(m), paths, this.dir('staging', game.id), { choices: m.choices });
        forgetStaged(res.stagedPath);
        m.stagedPath = res.stagedPath;
      } catch (e) {
        errors.push(`«${m.title}»: ${(e as Error).message}`);
      }
    }
    this.changed();
    if (game.activeProfileId === profileId) await this.deploy(profileId);
    if (errors.length) throw new Error(errors.join('\n'));
  }

  async purge(gameId: string): Promise<number> {
    const game = this.game(gameId);
    const r = await purge(this.dir('deploy', gameId, 'manifest.json'), this.deployRoot(game), this.dir('deploy', gameId, 'backup'));
    if (r.failed.length) throw new Error(lockedMessage(r.failed));
    const def = this.defOf(game);
    if (def.pluginsTxt) await restorePluginsTxt(pluginsTxtPath(this.pluginsFolder(game, def)), this.dir('deploy', gameId));
    for (const p of this.store.state.profiles.filter((x) => x.gameId === gameId)) p.deployedAt = undefined;
    this.changed();
    return r.removed;
  }

  // ---------- FOMOD

  /** The installer of an installed mod, with the options picked last time. */
  async fomodPrompt(profileId: string, key: string): Promise<FomodPrompt | null> {
    const p = this.profile(profileId);
    const m = p.mods[key];
    if (!m) throw new Error(t('Мод не найден'));
    const f = m.files[0];
    if (!f || f.url.startsWith(STAGED_PREFIX)) return null;
    const file = await this.fetchFile(f, m.title, p.gameId);
    const config = await inspectFomod(file);
    if (!config) return null;
    const { state, active } = await this.fileState(p);
    return { key, title: m.title, config, choices: m.choices ?? defaultChoices(config, state), activePlugins: active };
  }

  /** Re-runs a mod's FOMOD installer with new options and redeploys. */
  async reinstallWithChoices(profileId: string, key: string, choices: FomodChoices) {
    const p = this.profile(profileId);
    const m = p.mods[key];
    if (!m) throw new Error(t('Мод не найден'));
    const game = this.game(p.gameId);
    const def = this.defOf(game);
    const { state } = await this.fileState(p);
    const config = await inspectFomod(await this.fetchFile(m.files[0], m.title, p.gameId));
    if (config) {
      const errors = validateChoices(config, choices, state);
      if (errors.length) throw new Error(errors.join('\n'));
    }
    this.snapshot(profileId, t('Перед сменой опций «{0}»', m.title));
    const paths = await Promise.all(m.files.map((f) => this.fetchFile(f, m.title, p.gameId)));
    const version: ModVersion = { ...installedVersion(m) };
    const res = await stageVersion(def, version, paths, this.dir('staging', game.id), { choices, fileState: state });
    forgetStaged(res.stagedPath);
    m.stagedPath = res.stagedPath;
    m.choices = res.choices;
    this.changed();
    this.toast('ok', t('«{0}» переустановлен с новыми опциями', m.title));
    if (game.activeProfileId === profileId) await this.deploy(profileId).catch((e) => this.toast('err', (e as Error).message));
  }

  // ---------- Nexus Mods

  /** Whether this build can sign in through Nexus (it has the app slug Nexus issued). */
  nexusSsoAvailable(): boolean {
    return NEXUS_SLUG !== '';
  }

  /**
   * Sign in through Nexus SSO: the user approves Lattice on nexusmods.com and
   * Nexus hands back their key for this app. The way Nexus wants public apps to work.
   */
  async loginWithNexus(): Promise<{ name: string; premium: boolean }> {
    const key = await nexusSso({ slug: NEXUS_SLUG, openBrowser: this.openBrowser });
    return this.setNexusKey(key);
  }

  /** Checks a personal API key with Nexus and stores it encrypted (test builds before registration). */
  async setNexusKey(key: string): Promise<{ name: string; premium: boolean }> {
    const user = await this.sources.nexus.validateKey(key.trim());
    this.store.state.settings = { ...this.settings, nexusKeyEnc: this.secrets.encrypt(key.trim()), nexusUser: user };
    this.changed();
    return user;
  }

  clearNexusKey() {
    const { nexusKeyEnc: _k, nexusUser: _u, ...rest } = this.settings;
    this.store.state.settings = rest as Settings;
    this.changed();
  }

  /**
   * An nxm:// link from "Mod Manager Download" on nexusmods.com: remembers its
   * one-time key and builds the install plan for the active game that matches.
   */
  async handleNxm(url: string): Promise<InstallPlan> {
    const link = parseNxm(url);
    if (!link) throw new Error(t('Не похоже на ссылку nxm://'));
    if (link.expires && link.expires * 1000 < Date.now()) throw new Error(t('Ссылка Nexus устарела — нажмите кнопку на сайте ещё раз'));
    const s = this.store.state;
    const candidates = s.games.filter((g) => gameDef(g.defId)?.nexusDomain === link.domain);
    const game = candidates.find((g) => g.id === s.activeGameId) ?? candidates[0];
    if (!game) throw new Error(t('Игра {0} не добавлена в Lattice', link.domain));
    this.nxmKeys.set(`${link.domain}/${link.modId}/${link.fileId}`, link);
    if (s.activeGameId !== game.id) {
      s.activeGameId = game.id;
      this.changed();
    }
    const plan = await this.planInstall(game.activeProfileId, [{ ref: { source: 'nexus', projectId: `${link.domain}/${link.modId}` }, versionId: String(link.fileId) }]);
    this.emit('plan', plan);
    return plan;
  }

  // ---------- snapshots

  snapshot(profileId: string, label: string): Snapshot {
    const p = this.profile(profileId);
    const s: Snapshot = {
      id: randomUUID(),
      profileId,
      label,
      createdAt: new Date().toISOString(),
      mods: structuredClone(p.mods),
      rules: structuredClone(p.rules),
      collections: [...p.collections],
    };
    this.store.state.snapshots.unshift(s);
    this.trimSnapshots();
    this.changed();
    return s;
  }

  /** Keeps the newest snapshots of each profile, as many as the settings say. */
  private trimSnapshots() {
    const limit = this.settings.snapshotLimit ?? MAX_SNAPSHOTS;
    const count = new Map<string, number>();
    const before = this.store.state.snapshots.length;
    this.store.state.snapshots = this.store.state.snapshots.filter((x) => {
      const n = (count.get(x.profileId) ?? 0) + 1;
      count.set(x.profileId, n);
      return n <= limit;
    });
    return before - this.store.state.snapshots.length;
  }

  async rollback(snapshotId: string) {
    const s = this.store.state.snapshots.find((x) => x.id === snapshotId);
    if (!s) throw new Error(t('Снимок не найден'));
    const p = this.profile(s.profileId);
    const missing: string[] = [];
    for (const m of Object.values(s.mods)) {
      if (!(await fs.stat(m.stagedPath).catch(() => null))) missing.push(m.title);
    }
    if (missing.length) throw new Error(t('Нет файлов для: {0}. Их можно переустановить из плана.', missing.slice(0, 5).join(', ')));
    this.snapshot(p.id, t('Перед откатом к «{0}»', s.label));
    p.mods = structuredClone(s.mods);
    p.rules = structuredClone(s.rules);
    p.collections = [...s.collections];
    this.changed();
    this.toast('ok', t('Профиль возвращён к состоянию «{0}»', s.label));
    const game = this.game(p.gameId);
    if (game.activeProfileId === p.id) await this.deploy(p.id).catch((e) => this.toast('err', (e as Error).message));
  }

  deleteSnapshot(id: string) {
    this.store.state.snapshots = this.store.state.snapshots.filter((x) => x.id !== id);
    this.changed();
    this.tidy();
  }

  // ---------- settings

  updateSettings(patch: Partial<Settings>) {
    // secrets have their own methods; the renderer only ever sees a mask
    const { nexusKeyEnc: _k, nexusUser: _u, ...safe } = patch;
    if (safe.githubToken === '••••') delete safe.githubToken;
    if (safe.curseforgeKey === '••••') delete safe.curseforgeKey;
    if (safe.modrinthToken === '••••') delete safe.modrinthToken;
    const next = { ...this.settings, ...safe, dataRoot: this.settings.dataRoot };
    next.maxParallelDownloads = clamp(next.maxParallelDownloads, 1, 32);
    next.maxConnectionsPerFile = clamp(next.maxConnectionsPerFile, 1, 32);
    next.minSegmentMiB = clamp(next.minSegmentMiB, 0.25, 64);
    if (next.snapshotLimit !== undefined) next.snapshotLimit = Math.round(clamp(next.snapshotLimit, 3, 100));
    next.trustedHosts = [...new Set(next.trustedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean))];
    if (next.language && !LANGS.some((l) => l.id === next.language)) next.language = this.settings.language;
    if (next.language) setLang(next.language);
    this.store.state.settings = next;
    // a lower snapshot limit takes effect with the next snapshot or start, not on every click of the stepper
    this.changed();
  }
}

/** Bytes in a folder and everything under it. */
async function dirSize(p: string): Promise<number> {
  let n = 0;
  for (const rel of await walk(p).catch(() => [] as string[])) n += (await fs.stat(path.join(p, rel)).catch(() => null))?.size ?? 0;
  return n;
}

/** Carries known FOMOD options into a plan: the last install's, or a collection's lock. */
function attachChoices(plan: InstallPlan, p: Profile, locked: Map<string, FomodChoices> = new Map()) {
  for (const it of [...plan.install, ...plan.update]) it.choices = locked.get(it.key) ?? p.mods[it.key]?.choices;
}

function installedVersion(m: InstalledMod): ModVersion {
  return {
    ref: m.ref,
    versionId: m.versionId,
    version: m.version,
    gameVersions: m.gameVersions,
    loaders: m.loaders,
    published: m.installedAt,
    files: m.files,
    deps: m.deps,
    provides: m.provides,
  };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
}

function sameRule(a: OrderRule, b: OrderRule) {
  return a.subject === b.subject && a.kind === b.kind && a.other === b.other;
}

/** What to tell the user when files in the game folder could not be changed. */
function lockedMessage(failed: DeployFailure[]): string {
  const sample = failed
    .slice(0, 3)
    .map((f) => `${f.rel} (${f.error})`)
    .join(', ');
  return t(
    'Не удалось изменить в папке игры: {0}. Скорее всего, их держит открытыми запущенная игра или лаунчер — закройте их и нажмите «Применить к игре». Например: {1}',
    plural(failed.length, 'файл', 'файла', 'файлов'),
    sample,
  );
}

/** One mod's jars (a main jar and add-ons) as one declaration. */
function mergeJarMeta(metas: JarMeta[]): JarMeta {
  return {
    ids: metas.flatMap((x) => x.ids),
    versions: Object.assign({}, ...metas.map((x) => x.versions)),
    depends: metas.flatMap((x) => x.depends),
    breaks: metas.flatMap((x) => x.breaks),
    loaders: [...new Set(metas.flatMap((x) => x.loaders ?? []))],
  };
}
