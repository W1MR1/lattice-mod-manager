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
import type { FomodPrompt, GameDef, HealthProblem } from '../../shared/types';
import { keyOf } from '../../shared/types';
import { defaultChoices, validateChoices, type FileState, type FomodChoices } from '../../shared/fomod';
import { checkCompatibility, type PluginCheck, type PluginInfo } from './compat';
import { collectionClosure, fromProfile, importMrpack, parseCollection, slugId, type CollectionMeta } from './collections';
import { computeOverlaps, deploy, forgetStaged, purge, verifyDeployment } from './deployer';
import { DownloadManager } from './downloader';
import { detectGames, GAME_DEFS, gameDef } from './games';
import { FomodRequired, inspectFomod, STAGED_PREFIX, safeName, stageVersion, walk } from './installer';
import { computeOrder, providerIndex } from './loadorder';
import { PLUGIN_EXT, pluginMasters, pluginsTxtPath, restorePluginsTxt, writePluginsTxt } from './plugins';
import { resolvePlan, type ProjectMeta } from './resolver';
import { Sources } from './sources';
import { parseNexusUrl, parseNxm, type NxmLink } from './sources/nexus';
import { Store } from './store';
import { collectOrphans, recomputeLinks } from './links';
import { applyRemoval, planRemoval, type RemovalOptions } from './removal';
import { scanLeftovers, type Leftover } from './cleanup';
import { findMinecraftLauncher, gameLaunchTarget, installMinecraftLoader, isOfficialMinecraftDir, type LaunchTarget } from './launch';
export { collectOrphans, recomputeLinks } from './links';
import { NEXUS_SLUG } from './app-info';
import { nexusSso } from './nexus-sso';

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
      throw new Error('Запуск игр недоступен');
    },
  ) {
    super();
    this.store = new Store(stateFile, dataRoot);
    this.sources = new Sources(
      () => this.dir('cache'),
      gameDef,
      () => this.settings.githubToken,
      () => this.store.state.local,
      () => this.nexusKey(),
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
    return { ...pub, settings: { ...settings, githubToken: settings.githubToken ? '••••' : undefined } };
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
    if (!p) throw new Error('Профиль не найден');
    return p;
  }

  private game(id: string): ManagedGame {
    const g = this.store.state.games.find((x) => x.id === id);
    if (!g) throw new Error('Игра не найдена');
    return g;
  }

  private defOf(game: ManagedGame) {
    const d = gameDef(game.defId);
    if (!d) throw new Error(`Неизвестная игра ${game.defId}`);
    return d;
  }

  // ---------- games and profiles

  gameDefs() {
    return GAME_DEFS;
  }

  detectGames() {
    return detectGames();
  }

  async minecraftVersions(): Promise<string[]> {
    return this.sources.modrinth.gameVersions();
  }

  async addGame(defId: string, installPath: string, ctx: Partial<GameContext> = {}): Promise<ManagedGame> {
    const def = gameDef(defId);
    if (!def) throw new Error('Неизвестная игра');
    const st = await fs.stat(installPath).catch(() => null);
    if (!st?.isDirectory()) throw new Error('Папка игры не найдена');
    const id = `${defId}-${randomUUID().slice(0, 6)}`;
    const profile: Profile = {
      id: randomUUID(),
      gameId: id,
      name: 'Основной',
      context: { gameDefId: defId, gameVersion: ctx.gameVersion, loader: ctx.loader ?? def.loaders?.[0] },
      mods: {},
      rules: [],
      collections: [],
      createdAt: new Date().toISOString(),
    };
    const game: ManagedGame = { id, defId, name: def.name, installPath, activeProfileId: profile.id, addedAt: new Date().toISOString() };
    this.store.state.games.push(game);
    this.store.state.profiles.push(profile);
    this.store.state.activeGameId = id;
    this.changed();
    return game;
  }

  async removeGame(id: string) {
    this.game(id);
    await this.purge(id).catch(() => 0);
    const s = this.store.state;
    const profileIds = new Set(s.profiles.filter((p) => p.gameId === id).map((p) => p.id));
    s.games = s.games.filter((g) => g.id !== id);
    s.profiles = s.profiles.filter((p) => p.gameId !== id);
    s.snapshots = s.snapshots.filter((x) => !profileIds.has(x.profileId));
    if (s.activeGameId === id) s.activeGameId = s.games[0]?.id;
    this.changed();
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
      name: name || 'Новый профиль',
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
    if (others.length === 0) throw new Error('Нельзя удалить единственный профиль игры');
    if (game.activeProfileId === id) await this.switchProfile(game.id, others[0].id);
    this.store.state.profiles = this.store.state.profiles.filter((x) => x.id !== id);
    this.store.state.snapshots = this.store.state.snapshots.filter((s) => s.profileId !== id);
    this.changed();
  }

  async switchProfile(gameId: string, profileId: string) {
    const game = this.game(gameId);
    this.profile(profileId);
    if (game.activeProfileId === profileId) return;
    await this.purge(gameId).catch(() => 0);
    game.activeProfileId = profileId;
    this.changed();
    await this.deploy(profileId).catch((e) => this.toast('err', `Развёртывание: ${(e as Error).message}`));
  }

  // ---------- compatibility

  async compat(profileId: string): Promise<CompatReport> {
    const p = this.profile(profileId);
    const { order } = computeOrder(Object.values(p.mods), p.rules);
    const overlaps = await computeOverlaps(order, p.mods).catch(() => []);
    const game = this.game(p.gameId);
    const def = this.defOf(game);
    const pluginCheck = def.pluginsTxt ? await this.pluginCheck(p, game, def, order) : undefined;
    return checkCompatibility(p, this.store.state.collections, overlaps, pluginCheck);
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
    return this.sources.provider(p.context).versions(ref, p.context);
  }

  // ---------- planning

  private storePlan(plan: InstallPlan): InstallPlan {
    this.plans.set(plan.id, plan);
    if (this.plans.size > 20) this.plans.delete(this.plans.keys().next().value!);
    return plan;
  }

  async planInstall(profileId: string, requests: PlanRequest[], opts: { allowUpdates?: boolean; label?: string } = {}): Promise<InstallPlan> {
    const p = this.profile(profileId);
    const label = opts.label ?? (requests.length === 1 ? `Установка «${requests[0].title ?? requests[0].ref.projectId}»` : `Установка ${requests.length} модов`);
    const plan = await resolvePlan(
      { profile: p, requests, reason: 'explicit', includeRecommended: this.settings.includeRecommended, allowUpdates: opts.allowUpdates ?? true, label },
      this.sources.provider(p.context),
      randomUUID(),
    );
    attachChoices(plan, p);
    return this.storePlan(plan);
  }

  async planUpdates(profileId: string, keys?: string[]): Promise<InstallPlan> {
    const p = this.profile(profileId);
    const targets = (keys ?? Object.keys(p.mods)).map((k) => p.mods[k]).filter((m) => m && m.enabled && m.ref.source !== 'local');
    return this.planInstall(
      profileId,
      targets.map((m) => ({ ref: m.ref, title: m.title })),
      { allowUpdates: true, label: keys?.length === 1 ? `Обновление «${targets[0]?.title}»` : 'Безопасное обновление модов' },
    );
  }

  async planCollection(profileId: string, collectionId: string): Promise<InstallPlan> {
    const p = this.profile(profileId);
    const all = this.store.state.collections;
    const { order: chain, missing } = collectionClosure(collectionId, all);
    const target = chain[chain.length - 1];
    if (!target) throw new Error('Коллекция не найдена');
    const extra: Issue[] = [];
    if (target.game.defId !== p.context.gameDefId) throw new Error(`Коллекция «${target.name}» для другой игры`);
    if ((target.game.gameVersion && target.game.gameVersion !== p.context.gameVersion) || (target.game.loader && target.game.loader !== p.context.loader)) {
      extra.push({
        id: `ctx:${target.id}`,
        severity: 'warning',
        code: 'incompatible-game',
        subject: `collection:${target.id}`,
        related: [],
        message: `Коллекция собрана для ${[target.game.gameVersion, target.game.loader].filter(Boolean).join(' + ')}, а профиль — ${[p.context.gameVersion, p.context.loader].filter(Boolean).join(' + ')}. Закреплённые версии могут быть заменены. Надёжнее создать отдельный профиль под коллекцию.`,
      });
    }
    for (const m of missing) {
      extra.push({
        id: `missing:${m.collectionId}`,
        severity: 'error',
        code: 'collection-missing',
        subject: `collection:${target.id}`,
        related: [`collection:${m.collectionId}`],
        message: `Коллекция строится поверх «${m.name ?? m.collectionId}»${m.range ? ` ${m.range}` : ''}, но её нет в библиотеке. Импортируйте её.`,
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
          message: `«${c.name}» несовместима с «${other?.name ?? link.collectionId}»${link.reason ? `: ${link.reason}` : ''}.`,
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
    const plan = await resolvePlan(
      { profile: p, requests, reason: 'collection', includeRecommended: false, allowUpdates: true, label: `Коллекция «${target.name}»` },
      this.sources.provider(p.context, overlay, overlayMeta),
      randomUUID(),
    );
    plan.issues = [...extra, ...plan.issues];
    plan.ok = !plan.issues.some((i) => i.severity === 'error');
    plan.collectionIds = chain.map((c) => c.id);
    // FOMOD options locked in the collection replay without questions.
    const locked = new Map<string, FomodChoices>();
    for (const c of chain) for (const m of c.mods) if (m.choices) locked.set(keyOf(m.ref), m.choices);
    attachChoices(plan, p, locked);
    return this.storePlan(plan);
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

  private async fetchFile(f: ModFile, title: string): Promise<string> {
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
      if (!this.isTrusted(url)) throw new Error(`Nexus вернул ссылку на неизвестный хост: ${new URL(url).hostname}`);
      // Free accounts are limited by Nexus per connection; one connection keeps within their terms.
      const premium = this.settings.nexusUser?.premium === true;
      return this.downloads.enqueue({ url, dest, title, size: f.size, hashes: f.hashes, maxConnections: premium ? undefined : 1 }).done;
    }
    if (!this.isTrusted(f.url)) {
      let host = f.url;
      try {
        host = new URL(f.url).hostname;
      } catch {
        /* keep url */
      }
      throw new Error(`источник ${host} не в списке доверенных (Настройки → Источники)`);
    }
    return this.downloads.enqueue({ url: f.url, dest, title, size: f.size, hashes: f.hashes }).done;
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
    if (!plan) throw new Error('План устарел, постройте его заново');
    const profile = this.profile(plan.profileId);
    const def = this.defOf(this.game(profile.gameId));
    if (def.kind !== 'generic') return [];
    const { state, active } = await this.fileState(profile);
    const prompts: FomodPrompt[] = [];
    await Promise.all(
      [...plan.install, ...plan.update].map(async (it) => {
        const files = this.primaryFiles(it.version);
        if (files.length !== 1 || files[0].url.startsWith(STAGED_PREFIX)) return;
        const file = await this.fetchFile(files[0], it.title);
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
    if (!plan) throw new Error('План устарел, постройте его заново');
    if (!plan.ok && !force) throw new Error('В плане есть ошибки совместимости');
    const profile = this.profile(plan.profileId);
    const game = this.game(profile.gameId);
    const def = this.defOf(game);
    const items: PlanItem[] = [...plan.install, ...plan.update];
    const before = items.length || plan.collectionIds.length ? this.snapshot(profile.id, `Перед: ${plan.label}`) : null;

    const staged = new Map<string, { path: string; files: ModFile[]; choices?: FomodChoices }>();
    const warnings: string[] = [];
    const failures: string[] = [];
    const fs0 = def.kind === 'generic' ? await this.fileState(profile) : null;
    await Promise.all(
      items.map(async (it) => {
        try {
          const files = this.primaryFiles(it.version);
          if (files.length === 0) throw new Error('у версии нет файлов');
          const paths = await Promise.all(files.map((f) => this.fetchFile(f, it.title)));
          const root = this.dir('staging', game.id);
          const version = { ...it.version, files };
          let res;
          try {
            res = await stageVersion(def, version, paths, root, { choices: choices[it.key] ?? it.choices, fileState: fs0?.state });
          } catch (e) {
            if (!(e instanceof FomodRequired)) throw e;
            // Nobody answered the installer (scripted install): take its defaults, say so.
            res = await stageVersion(def, version, paths, root, { choices: defaultChoices(e.config, fs0?.state), fileState: fs0?.state });
            warnings.push(`«${it.title}»: установщик FOMOD пройден с вариантами по умолчанию — их можно изменить в карточке мода`);
          }
          forgetStaged(res.stagedPath);
          warnings.push(...res.warnings.map((w) => `«${it.title}»: ${w}`));
          staged.set(it.key, { path: res.stagedPath, files, choices: res.choices });
        } catch (e) {
          failures.push(`«${it.title}»: ${(e as Error).message}`);
        }
      }),
    );
    if (failures.length) throw new Error(`Не удалось установить:\n${failures.join('\n')}`);

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
      items.length ? `${plan.label} — готово, изменено модов: ${items.length}` : `${plan.label} — готово`,
      before ? { label: 'Откатить', snapshotId: before.id } : undefined,
    );
    await this.deploy(profile.id).catch((e) => this.toast('err', `Развёртывание: ${(e as Error).message}`));
    return { applied: items.length, warnings };
  }

  // ---------- mods

  async setEnabled(profileId: string, key: string, enabled: boolean) {
    const p = this.profile(profileId);
    const m = p.mods[key];
    if (!m) throw new Error('Мод не найден');
    m.enabled = enabled;
    this.changed();
    await this.deploy(profileId).catch(() => undefined);
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
    this.snapshot(profileId, plan.remove.length === 1 ? `Перед удалением «${p.mods[plan.remove[0]].title}»` : `Перед удалением модов (${plan.remove.length})`);
    const gone = [...plan.remove, ...(opts.withDeps ? plan.deps : [])].map((k) => p.mods[k]).filter(Boolean);
    applyRemoval(p, plan, opts);
    this.changed();
    await this.deploy(profileId).catch(() => undefined);
    const leftovers = opts.thorough ? await this.findLeftovers(p.gameId, gone) : [];
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
    await this.deploy(profileId).catch(() => undefined);
  }

  async removeRule(profileId: string, rule: OrderRule) {
    const p = this.profile(profileId);
    p.rules = p.rules.filter((r) => !sameRule(r, rule));
    this.changed();
    await this.deploy(profileId).catch(() => undefined);
  }

  /** User-declared link between two installed mods (kept across updates). */
  setUserLink(profileId: string, key: string, dep: DepDecl | null, removeKey?: string) {
    const p = this.profile(profileId);
    const m = p.mods[key];
    if (!m) throw new Error('Мод не найден');
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
    return this.planInstall(profileId, requests, { label: paths.length === 1 ? `Локальный мод «${requests[0].title}»` : `Локальные моды (${paths.length})` });
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
    if (!c) throw new Error('Коллекция не найдена');
    if (patch.requires?.some((l) => l.collectionId === id) || patch.conflicts?.some((l) => l.collectionId === id)) throw new Error('Коллекция не может ссылаться на саму себя');
    Object.assign(c, patch);
    if (patch.requires) {
      for (const l of patch.requires) {
        const cyc = collectionClosure(l.collectionId, this.store.state.collections).order.some((x) => x.id === id);
        if (cyc) throw new Error('Получилась циклическая цепочка коллекций');
      }
    }
    this.changed();
  }

  /** Re-locks a collection from the profile's current state (new version). */
  relockCollection(id: string, profileId: string, version: string) {
    const c = this.store.state.collections.find((x) => x.id === id);
    if (!c) throw new Error('Коллекция не найдена');
    const fresh = fromProfile(this.profile(profileId), { ...c, version }, this.store.state.collections.filter((x) => x.id !== id));
    Object.assign(c, { mods: fresh.mods, rules: fresh.rules, game: fresh.game, version, createdAt: fresh.createdAt });
    this.changed();
  }

  deleteCollection(id: string) {
    const s = this.store.state;
    const users = s.collections.filter((c) => c.requires.some((r) => r.collectionId === id));
    if (users.length) throw new Error(`На неё ссылаются: ${users.map((u) => `«${u.name}»`).join(', ')}`);
    s.collections = s.collections.filter((c) => c.id !== id);
    for (const p of s.profiles) p.collections = p.collections.filter((x) => x !== id);
    this.changed();
  }

  async exportCollection(id: string, file: string) {
    const c = this.store.state.collections.find((x) => x.id === id);
    if (!c) throw new Error('Коллекция не найдена');
    await fs.writeFile(file, JSON.stringify(c, null, 2));
    this.toast('ok', `Коллекция сохранена: ${path.basename(file)}`);
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
    this.toast('ok', `Коллекция «${c.name}» добавлена в библиотеку`);
  }

  /** Downloads a Modrinth modpack and turns it into a collection. */
  async importModpack(ref: ModRef): Promise<Collection> {
    const versions = await this.sources.modrinth.versions(ref, { gameDefId: 'minecraft' });
    const v = versions.sort((a, b) => Date.parse(b.published) - Date.parse(a.published))[0];
    if (!v) throw new Error('У сборки нет версий');
    const f = v.files.find((x) => x.primary) ?? v.files[0];
    const file = await this.fetchFile(f, `Сборка ${v.name ?? v.version}`);
    const c = await importMrpack(file, this.sources.modrinth, this.dir('staging', '_shared'));
    this.upsertCollection(c);
    return c;
  }

  createProfileForCollection(collectionId: string, gameId: string): Profile {
    const c = this.store.state.collections.find((x) => x.id === collectionId);
    if (!c) throw new Error('Коллекция не найдена');
    const p = this.createProfile(gameId, c.name, { gameVersion: c.game.gameVersion, loader: c.game.loader });
    return p;
  }

  async removeCollectionFromProfile(profileId: string, collectionId: string): Promise<string[]> {
    const p = this.profile(profileId);
    const dependents = this.store.state.collections.filter((c) => p.collections.includes(c.id) && c.requires.some((r) => r.collectionId === collectionId));
    if (dependents.length) throw new Error(`Сначала уберите коллекции, которые на ней строятся: ${dependents.map((d) => `«${d.name}»`).join(', ')}`);
    this.snapshot(profileId, 'Перед удалением коллекции');
    p.collections = p.collections.filter((x) => x !== collectionId);
    for (const m of Object.values(p.mods)) m.requiredBy = m.requiredBy.filter((r) => r !== `collection:${collectionId}`);
    const removed = collectOrphans(p);
    this.changed();
    await this.deploy(profileId).catch(() => undefined);
    return removed;
  }

  // ---------- deployment

  private deployRoot(game: ManagedGame) {
    return path.join(game.installPath, this.defOf(game).deployDir);
  }

  async deploy(profileId: string): Promise<DeployResult> {
    const p = this.profile(profileId);
    const game = this.game(p.gameId);
    if (game.activeProfileId !== profileId) throw new Error('Профиль не активен');
    const st = await fs.stat(game.installPath).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`Папка игры не найдена: ${game.installPath}`);
    const { order } = computeOrder(Object.values(p.mods), p.rules);
    const res = await deploy({
      root: this.deployRoot(game),
      order,
      mods: p.mods,
      manifestPath: this.dir('deploy', game.id, 'manifest.json'),
      backupDir: this.dir('deploy', game.id, 'backup'),
      method: this.settings.deployMethod,
    });
    const def = this.defOf(game);
    if (def.pluginsTxt) {
      const plugins = (await this.pluginOrder(profileId)).map((x) => x.name);
      await writePluginsTxt(pluginsTxtPath(def.pluginsTxt.folder), this.dir('deploy', game.id), plugins);
    }
    p.deployedAt = new Date().toISOString();
    this.changed();
    const out = { ...res, root: this.deployRoot(game) };
    this.emit('deployed', { profileId, ...out });
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
    if (def.kind === 'minecraft') {
      if (!(await isOfficialMinecraftDir(game.installPath))) {
        throw new Error('Это папка стороннего лаунчера (Prism, MultiMC, TLauncher и т. п.): моды уже лежат в её mods/, запустите этот экземпляр в самом лаунчере.');
      }
      if (!p.context.gameVersion) throw new Error('Укажите версию Minecraft у профиля (Настройки → профиль), чтобы поставить загрузчик под неё.');
      const res = await installMinecraftLoader(game.installPath, p.context.gameVersion, p.context.loader ?? 'fabric', p.id, p.name);
      const exe = await findMinecraftLauncher();
      if (!exe) return { note: `Профиль «${res.profileName}» добавлен в лаунчер Minecraft. Откройте лаунчер, выберите этот профиль и нажмите «Играть».` };
      await this.launcher({ kind: 'exe', path: exe });
      return { note: `Открываем лаунчер Minecraft: выберите профиль «${res.profileName}» и нажмите «Играть».` };
    }
    const target = await gameLaunchTarget(def, game.installPath);
    await this.launcher(target);
    return { note: target.kind === 'steam' ? `Запускаем ${game.name} через Steam` : `Запускаем ${path.basename(target.path)}` };
  }

  /** Points a game at a new folder (it was moved); the old folder is cleaned first when it still exists. */
  async setGamePath(gameId: string, installPath: string) {
    const game = this.game(gameId);
    const st = await fs.stat(installPath).catch(() => null);
    if (!st?.isDirectory()) throw new Error('Папка не найдена');
    if (await fs.stat(game.installPath).catch(() => null)) await this.purge(gameId).catch(() => 0);
    game.installPath = installPath;
    this.changed();
    await this.deploy(game.activeProfileId).catch((e) => this.toast('err', (e as Error).message));
  }

  // ---------- integrity

  /** Problems worth fixing at start: missing files, broken deployment, contradicting rules, half downloads. */
  async healthCheck(): Promise<HealthProblem[]> {
    const out: HealthProblem[] = [];
    if (this.store.recovered) {
      out.push({ id: 'state-recovered', title: 'Файл настроек Lattice был повреждён', detail: 'Загружена последняя исправная копия. Проверьте, все ли игры и профили на месте.', fixable: false });
    }
    for (const game of this.store.state.games) {
      if (!(await fs.stat(game.installPath).catch(() => null))?.isDirectory()) {
        out.push({ id: `folder:${game.id}`, title: `${game.name}: папка игры не найдена`, detail: `${game.installPath} — игру переместили или удалили. Укажите новую папку в настройках.`, fixable: false, gameId: game.id });
        continue;
      }
      const p = this.store.state.profiles.find((x) => x.id === game.activeProfileId);
      if (!p) continue;
      const missing: InstalledMod[] = [];
      for (const m of Object.values(p.mods)) if (!(await fs.stat(m.stagedPath).catch(() => null))) missing.push(m);
      if (missing.length) {
        out.push({
          id: `staging:${p.id}`,
          title: `${game.name}: пропали файлы модов (${missing.length})`,
          detail: `${missing.slice(0, 4).map((m) => `«${m.title}»`).join(', ')}${missing.length > 4 ? '…' : ''}. Lattice скачает и подготовит их заново.`,
          fixable: true,
          profileId: p.id,
          keys: missing.map((m) => m.key),
        });
      }
      const { cycles } = computeOrder(Object.values(p.mods), p.rules);
      if (cycles.length) {
        out.push({
          id: `cycle:${p.id}`,
          title: `${game.name}: правила порядка загрузки противоречат друг другу`,
          detail: cycles.map((c) => c.map((k) => `«${p.mods[k]?.title ?? k}»`).join(' → ')).join('; ') + '. Lattice уберёт противоречащие правила.',
          fixable: true,
          profileId: p.id,
        });
      }
      if (p.deployedAt) {
        const v = await verifyDeployment(this.dir('deploy', game.id, 'manifest.json'), this.deployRoot(game));
        if (v.missing.length) {
          out.push({
            id: `deploy:${p.id}`,
            title: `${game.name}: в папке игры не хватает файлов модов (${v.missing.length})`,
            detail: 'Их удалили вручную или игра обновилась. Lattice разложит их заново.',
            fixable: true,
            profileId: p.id,
          });
        }
      }
    }
    const busy = this.downloads.list().some((d) => ['queued', 'probing', 'downloading', 'paused', 'verifying'].includes(d.state));
    const parts = busy ? [] : (await walk(this.dir('downloads')).catch(() => [] as string[])).filter((r) => r.endsWith('.part'));
    if (parts.length) {
      out.push({ id: 'parts', title: 'Недокачанные файлы в кэше загрузок', detail: `${parts.length} шт. остались от прерванных загрузок и только занимают место.`, fixable: true });
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
          await this.deploy(p.id).catch(() => undefined);
        } else if (pr.id.startsWith('deploy:')) await this.deploy(pr.profileId!);
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
        if (m.files.some((f) => f.url.startsWith(STAGED_PREFIX))) throw new Error('файлы сборки можно вернуть только повторным импортом коллекции');
        const paths = await Promise.all(m.files.map((f) => this.fetchFile(f, m.title)));
        const res = await stageVersion(def, installedVersion(m), paths, this.dir('staging', game.id), { choices: m.choices });
        forgetStaged(res.stagedPath);
        m.stagedPath = res.stagedPath;
      } catch (e) {
        errors.push(`«${m.title}»: ${(e as Error).message}`);
      }
    }
    this.changed();
    if (game.activeProfileId === profileId) await this.deploy(profileId).catch(() => undefined);
    if (errors.length) throw new Error(errors.join('\n'));
  }

  async purge(gameId: string): Promise<number> {
    const game = this.game(gameId);
    const n = await purge(this.dir('deploy', gameId, 'manifest.json'), this.deployRoot(game), this.dir('deploy', gameId, 'backup'));
    const def = this.defOf(game);
    if (def.pluginsTxt) await restorePluginsTxt(pluginsTxtPath(def.pluginsTxt.folder), this.dir('deploy', gameId));
    for (const p of this.store.state.profiles.filter((x) => x.gameId === gameId)) p.deployedAt = undefined;
    this.changed();
    return n;
  }

  // ---------- FOMOD

  /** The installer of an installed mod, with the options picked last time. */
  async fomodPrompt(profileId: string, key: string): Promise<FomodPrompt | null> {
    const p = this.profile(profileId);
    const m = p.mods[key];
    if (!m) throw new Error('Мод не найден');
    const f = m.files[0];
    if (!f || f.url.startsWith(STAGED_PREFIX)) return null;
    const file = await this.fetchFile(f, m.title);
    const config = await inspectFomod(file);
    if (!config) return null;
    const { state, active } = await this.fileState(p);
    return { key, title: m.title, config, choices: m.choices ?? defaultChoices(config, state), activePlugins: active };
  }

  /** Re-runs a mod's FOMOD installer with new options and redeploys. */
  async reinstallWithChoices(profileId: string, key: string, choices: FomodChoices) {
    const p = this.profile(profileId);
    const m = p.mods[key];
    if (!m) throw new Error('Мод не найден');
    const game = this.game(p.gameId);
    const def = this.defOf(game);
    const { state } = await this.fileState(p);
    const config = await inspectFomod(await this.fetchFile(m.files[0], m.title));
    if (config) {
      const errors = validateChoices(config, choices, state);
      if (errors.length) throw new Error(errors.join('\n'));
    }
    this.snapshot(profileId, `Перед сменой опций «${m.title}»`);
    const paths = await Promise.all(m.files.map((f) => this.fetchFile(f, m.title)));
    const version: ModVersion = { ...installedVersion(m) };
    const res = await stageVersion(def, version, paths, this.dir('staging', game.id), { choices, fileState: state });
    forgetStaged(res.stagedPath);
    m.stagedPath = res.stagedPath;
    m.choices = res.choices;
    this.changed();
    this.toast('ok', `«${m.title}» переустановлен с новыми опциями`);
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
    if (!link) throw new Error('Не похоже на ссылку nxm://');
    if (link.expires && link.expires * 1000 < Date.now()) throw new Error('Ссылка Nexus устарела — нажмите кнопку на сайте ещё раз');
    const s = this.store.state;
    const candidates = s.games.filter((g) => gameDef(g.defId)?.nexusDomain === link.domain);
    const game = candidates.find((g) => g.id === s.activeGameId) ?? candidates[0];
    if (!game) throw new Error(`Игра ${link.domain} не добавлена в Lattice`);
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
    const all = this.store.state.snapshots;
    all.unshift(s);
    const mine = all.filter((x) => x.profileId === profileId);
    if (mine.length > MAX_SNAPSHOTS) {
      const drop = new Set(mine.slice(MAX_SNAPSHOTS).map((x) => x.id));
      this.store.state.snapshots = all.filter((x) => !drop.has(x.id));
    }
    this.changed();
    return s;
  }

  async rollback(snapshotId: string) {
    const s = this.store.state.snapshots.find((x) => x.id === snapshotId);
    if (!s) throw new Error('Снимок не найден');
    const p = this.profile(s.profileId);
    const missing: string[] = [];
    for (const m of Object.values(s.mods)) {
      if (!(await fs.stat(m.stagedPath).catch(() => null))) missing.push(m.title);
    }
    if (missing.length) throw new Error(`Нет файлов для: ${missing.slice(0, 5).join(', ')}. Их можно переустановить из плана.`);
    this.snapshot(p.id, `Перед откатом к «${s.label}»`);
    p.mods = structuredClone(s.mods);
    p.rules = structuredClone(s.rules);
    p.collections = [...s.collections];
    this.changed();
    this.toast('ok', `Профиль возвращён к состоянию «${s.label}»`);
    const game = this.game(p.gameId);
    if (game.activeProfileId === p.id) await this.deploy(p.id).catch((e) => this.toast('err', (e as Error).message));
  }

  deleteSnapshot(id: string) {
    this.store.state.snapshots = this.store.state.snapshots.filter((x) => x.id !== id);
    this.changed();
  }

  // ---------- settings

  updateSettings(patch: Partial<Settings>) {
    // secrets have their own methods; the renderer only ever sees a mask
    const { nexusKeyEnc: _k, nexusUser: _u, ...safe } = patch;
    if (safe.githubToken === '••••') delete safe.githubToken;
    const next = { ...this.settings, ...safe, dataRoot: this.settings.dataRoot };
    next.maxParallelDownloads = clamp(next.maxParallelDownloads, 1, 32);
    next.maxConnectionsPerFile = clamp(next.maxConnectionsPerFile, 1, 32);
    next.minSegmentMiB = clamp(next.minSegmentMiB, 0.25, 64);
    next.trustedHosts = [...new Set(next.trustedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean))];
    this.store.state.settings = next;
    this.changed();
  }
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

