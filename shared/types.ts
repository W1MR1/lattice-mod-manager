// Types shared by the Electron main process and the renderer.
import type { FomodChoices, FomodConfig } from './fomod';
import type { Lang } from './i18n';

export type SourceId = 'modrinth' | 'thunderstore' | 'github' | 'nexus' | 'gamebanana' | 'curseforge' | 'local';

/** Identifies a project at a source. `key` form is `${source}:${projectId}`. */
export interface ModRef {
  source: SourceId;
  projectId: string;
}

export type DepKind = 'requires' | 'recommends' | 'optional' | 'conflicts' | 'embedded';

export interface DepDecl {
  ref: ModRef;
  kind: DepKind;
  /** semver range, e.g. ">=1.2.0" */
  range?: string;
  /** exact version pin (Modrinth sometimes pins a version id) */
  versionId?: string;
  name?: string;
  /** declared by the user in Lattice, kept across updates */
  user?: boolean;
}

export interface ModFile {
  url: string;
  filename: string;
  size?: number;
  hashes: { sha1?: string; sha256?: string; sha512?: string; md5?: string };
  primary?: boolean;
  /** exact relative path under the deploy root (from modpack manifests) */
  targetPath?: string;
}

export interface ModVersion {
  ref: ModRef;
  versionId: string;
  version: string;
  name?: string;
  gameVersions: string[];
  loaders: string[];
  published: string;
  files: ModFile[];
  deps: DepDecl[];
  /** capability keys this version also satisfies (e.g. a drop-in replacement) */
  provides?: string[];
  /** a patch or optional file: never picked automatically, only when asked for */
  optional?: boolean;
}

export type ProjectKind = 'mod' | 'modpack' | 'resourcepack' | 'shader' | 'library' | 'other';

export interface ModProject {
  ref: ModRef;
  title: string;
  summary: string;
  author: string;
  iconUrl?: string;
  downloads: number;
  updated: string;
  categories: string[];
  url: string;
  kind: ProjectKind;
  gameVersions?: string[];
  loaders?: string[];
}

export interface GameContext {
  /** id of the game definition, e.g. "minecraft" */
  gameDefId: string;
  gameVersion?: string;
  loader?: string;
}

export type GameKind = 'minecraft' | 'bepinex' | 'generic';

export interface GameDef {
  id: string;
  name: string;
  short: string;
  /** hue for the rail tile */
  hue: number;
  kind: GameKind;
  sources: SourceId[];
  thunderstoreCommunity?: string;
  steamAppId?: string;
  /** folder (relative to install path) that deployed files are placed under */
  deployDir: string;
  loaders?: string[];
  /** strip a single top-level folder from archives (generic games) */
  stripSingleRoot?: boolean;
  defaultPath?: string;
  notes?: string;
  /** game domain on Nexus Mods, e.g. "skyrimspecialedition" */
  nexusDomain?: string;
  /** GitHub search stays within the game: words every hit must mention, and a curated list */
  github?: { keywords: string; featured?: { repo: string; requires?: string[] }[] };
  /** Bethesda load order: plugins.txt under %LOCALAPPDATA%\<folder> */
  pluginsTxt?: { folder: string; baseMasters: string[] };
  /** files that identify the game in a folder (relative paths), whatever store it came from */
  exe?: string[];
  /** game id on GameBanana */
  gamebananaId?: number;
}

export type GameStore = 'steam' | 'gog' | 'epic' | 'xbox' | 'other';
export type McLauncher = 'official' | 'prism' | 'multimc' | 'legacy' | 'tlauncher' | 'curseforge' | 'modrinth' | 'atlauncher' | 'other';

/** Where a game copy came from and what starts it. */
export interface InstallInfo {
  store?: GameStore;
  /** Epic launch id: namespace:catalogItemId:appName */
  epicId?: string;
  /** Minecraft: the launcher that runs this folder */
  launcher?: McLauncher;
  /** Prism/MultiMC instance id (its folder name) */
  instanceId?: string;
  /** launcher folder that holds versions/ (for home/<version> folders it is their parent) */
  launcherRoot?: string;
  launcherExe?: string;
  /** the user chose the executable by hand: it is kept when Lattice looks again */
  customExe?: boolean;
}

export interface ManagedGame {
  id: string;
  defId: string;
  name: string;
  installPath: string;
  activeProfileId: string;
  addedAt: string;
  /** store or launcher of this copy; filled when the game is added or first checked */
  install?: InstallInfo;
}

export type InstallReason = 'explicit' | 'dependency' | 'collection';

export interface InstalledMod {
  key: string;
  ref: ModRef;
  title: string;
  author?: string;
  iconUrl?: string;
  versionId: string;
  version: string;
  gameVersions: string[];
  loaders: string[];
  enabled: boolean;
  reason: InstallReason;
  /** who pulled this in: mod keys or `collection:<id>` */
  requiredBy: string[];
  deps: DepDecl[];
  provides?: string[];
  files: ModFile[];
  /** absolute path of the staged copy */
  stagedPath: string;
  installedAt: string;
  sourceUrl?: string;
  /** options picked in the mod's FOMOD installer */
  choices?: FomodChoices;
}

export type RuleKind = 'before' | 'after';

/** Load-order / file-overwrite rule: `subject` loads before/after `other`. */
export interface OrderRule {
  subject: string;
  kind: RuleKind;
  other: string;
}

export interface Profile {
  id: string;
  gameId: string;
  name: string;
  context: GameContext;
  mods: Record<string, InstalledMod>;
  rules: OrderRule[];
  /** ids of collections applied to this profile */
  collections: string[];
  createdAt: string;
  deployedAt?: string;
}

export interface Snapshot {
  id: string;
  profileId: string;
  label: string;
  createdAt: string;
  mods: Record<string, InstalledMod>;
  rules: OrderRule[];
  collections: string[];
}

export interface CollectionLink {
  collectionId: string;
  name?: string;
  range?: string;
  reason?: string;
}

export interface CollectionMod {
  ref: ModRef;
  title: string;
  versionId: string;
  version: string;
  optional: boolean;
  files: ModFile[];
  deps: DepDecl[];
  gameVersions: string[];
  loaders: string[];
  /** FOMOD options replayed on install, so a collection installs without questions */
  choices?: FomodChoices;
}

/** A collection is a lockfile: exact versions + hashes + rules + links to other collections. */
export interface Collection {
  schema: 'lattice.collection/1';
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  game: { defId: string; gameVersion?: string; loader?: string };
  requires: CollectionLink[];
  conflicts: CollectionLink[];
  mods: CollectionMod[];
  rules: OrderRule[];
  createdAt: string;
  importedFrom?: string;
}

export type Severity = 'error' | 'warning' | 'info';

export type IssueCode =
  | 'missing-dep'
  | 'disabled-dep'
  | 'version-mismatch'
  | 'conflict'
  | 'cycle'
  | 'incompatible-game'
  | 'incompatible-loader'
  | 'file-conflict'
  | 'collection-missing'
  | 'collection-conflict'
  | 'unresolvable'
  | 'recommended'
  | 'missing-master'
  | 'duplicate'
  | 'jar-dependency'
  | 'jar-breaks';

export interface Fix {
  kind: 'install' | 'enable' | 'disable' | 'update' | 'add-rule' | 'apply-collection';
  label: string;
  ref?: ModRef;
  key?: string;
  versionId?: string;
  rule?: OrderRule;
  collectionId?: string;
}

export interface Issue {
  id: string;
  severity: Severity;
  code: IssueCode;
  subject: string;
  related: string[];
  message: string;
  fix?: Fix;
}

export interface CompatReport {
  score: number;
  errors: number;
  warnings: number;
  issues: Issue[];
  /** keys in deploy order (dependencies first) */
  order: string[];
  /** reverse dependency index: key -> keys that require it */
  dependents: Record<string, string[]>;
}

export interface PlanRequest {
  ref: ModRef;
  versionId?: string;
  range?: string;
  title?: string;
  /** who asks for it: `collection:<id>`; defaults to the user */
  by?: string;
}

export interface PlanItem {
  key: string;
  version: ModVersion;
  title: string;
  iconUrl?: string;
  author?: string;
  reason: InstallReason;
  requiredBy: string[];
  /** set when an installed mod changes version */
  fromVersion?: string;
  /** FOMOD options known in advance (previous install or a collection) */
  choices?: FomodChoices;
}

/** A FOMOD installer the user still has to go through before a plan applies. */
export interface FomodPrompt {
  key: string;
  title: string;
  config: FomodConfig;
  /** previous or default selection */
  choices: FomodChoices;
  /** plugin files already active in the load order, for fileDependency conditions */
  activePlugins: string[];
}

export interface InstallPlan {
  id: string;
  profileId: string;
  install: PlanItem[];
  update: PlanItem[];
  keep: string[];
  issues: Issue[];
  ok: boolean;
  /** collections (with everything they build on) this plan applies */
  collectionIds: string[];
  label: string;
}

export type DownloadState = 'queued' | 'probing' | 'downloading' | 'paused' | 'verifying' | 'done' | 'error' | 'cancelled';

export interface SegmentView {
  start: number;
  end: number;
  pos: number;
  active: boolean;
}

export interface DownloadView {
  id: string;
  url: string;
  host: string;
  filename: string;
  title: string;
  state: DownloadState;
  size: number;
  received: number;
  speed: number;
  segments: SegmentView[];
  connections: number;
  rangeSupported: boolean;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  verified?: 'sha512' | 'sha256' | 'sha1' | 'md5' | 'none';
  gameId?: string;
}

export interface Settings {
  dataRoot: string;
  theme: 'dark' | 'light';
  maxParallelDownloads: number;
  maxConnectionsPerFile: number;
  minSegmentMiB: number;
  deployMethod: 'hardlink' | 'copy';
  enabledSources: Record<SourceId, boolean>;
  trustedHosts: string[];
  githubToken?: string;
  includeRecommended: boolean;
  /** Nexus personal API key, encrypted with the OS keychain (never sent to the renderer) */
  nexusKeyEnc?: string;
  /** account the key belongs to, as reported by Nexus */
  nexusUser?: { name: string; premium: boolean };
  /** open nxm:// links ("Mod manager download" on Nexus) in Lattice */
  handleNxm: boolean;
  /** "don't offer for 7 days": no update prompt before this time (ms) */
  updateSnoozedUntil?: number;
  /** interface language; chosen in the installer, changeable in Settings */
  language?: Lang;
  /** CurseForge API key (the user's own; a build may carry one) */
  curseforgeKey?: string;
  /** Modrinth account: user name for public collections, or a personal access token */
  modrinthUser?: string;
  modrinthToken?: string;
  /** default trusted hosts already offered once; a host the user removed is not added back */
  trustedHostsSeen?: string[];
  /** snapshots kept per profile (30 when unset) */
  snapshotLimit?: number;
}

export interface AppState {
  games: ManagedGame[];
  profiles: Profile[];
  collections: Collection[];
  snapshots: Snapshot[];
  activeGameId?: string;
  settings: Settings;
}

export interface SearchQuery {
  source: SourceId;
  text: string;
  ctx: GameContext;
  kind?: ProjectKind;
  offset?: number;
  limit?: number;
  compatibleOnly?: boolean;
}

export interface SearchResult {
  hits: ModProject[];
  total: number;
  offset: number;
}

export interface DetectedGame {
  defId: string;
  /** the folder mods go to */
  path: string;
  via: GameStore | McLauncher;
  /** instance or profile name in its launcher */
  label?: string;
  /** "home": a per-version folder of Legacy Launcher or TLauncher */
  hint?: string;
  gameVersion?: string;
  loader?: string;
  install: InstallInfo;
}

/** Something found wrong at start, with or without an automatic fix. */
export interface HealthProblem {
  id: string;
  title: string;
  detail: string;
  fixable: boolean;
  gameId?: string;
  profileId?: string;
  keys?: string[];
}

export interface DeployResult {
  /** folder the files went to */
  root?: string;
  deployed: number;
  removed: number;
  backedUp: number;
  method: 'hardlink' | 'copy' | 'mixed';
  conflicts: { path: string; winner: string; losers: string[] }[];
  /** files that could not be changed (usually held open by the running game) */
  failed?: { rel: string; error: string }[];
}

export const keyOf = (ref: ModRef): string => `${ref.source}:${ref.projectId}`;

export function refOf(key: string): ModRef {
  const i = key.indexOf(':');
  return { source: key.slice(0, i) as SourceId, projectId: key.slice(i + 1) };
}
