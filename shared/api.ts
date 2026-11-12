// The one list of service methods the window may call. The main process
// checks every call against it; the renderer's typed `api` is built from it.
// A method missing here does not exist for the window; nothing else needs editing.
export const API_METHODS = [
  // state, games, profiles
  'state', 'gameDefs', 'detectGames', 'minecraftVersions', 'addGame', 'removeGame', 'setActiveGame', 'setGamePath', 'setLauncherExe',
  'createProfile', 'updateProfile', 'deleteProfile', 'switchProfile', 'exportProfile',
  // sources and planning
  'search', 'project', 'versions', 'planInstall', 'planUpdates', 'planCollection', 'applyFix', 'discardPlan', 'planDrop',
  // installing: questions an archive raises, files only the user can fetch
  'inspectPlan', 'applyPlan', 'fomodPrompt', 'fomodImage', 'reinstallWithChoices', 'layoutPrompt', 'reinstallWithLayout',
  'nexusNeeds', 'nexusPickup', 'nexusProvide', 'pickupFolder', 'importLocal',
  // mods of a profile
  'compat', 'setEnabled', 'dependentsOf', 'removeMod', 'previewRemoval', 'removeMods', 'removeAllMods', 'deleteLeftovers',
  'addRule', 'removeRule', 'setUserLink', 'pluginOrder',
  // collections and moving over from other managers
  'createCollection', 'updateCollection', 'relockCollection', 'deleteCollection', 'exportCollection', 'importCollectionFile', 'importModpack',
  'createProfileForCollection', 'removeCollectionFromProfile', 'scanImports', 'importPlan',
  // the game folder
  'deploy', 'purge', 'launchGame',
  // snapshots, upkeep, diagnostics
  'snapshot', 'rollback', 'deleteSnapshot', 'healthCheck', 'repair', 'diskUsage', 'freeUnused', 'backupAll', 'restoreBackup',
  'journal', 'problemReport', 'saveProblemReport',
  // settings and accounts
  'updateSettings', 'setNexusKey', 'clearNexusKey', 'handleNxm', 'nexusSsoAvailable', 'loginWithNexus',
  'curseforgeAvailable', 'curseforgeCheck', 'modrinthAccount', 'modrinthList',
] as const;

export type ApiMethod = (typeof API_METHODS)[number];
