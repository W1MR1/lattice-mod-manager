// Build-time facts about this release. scripts/build-main.mjs fills them in;
// tests and scripts run without a build and get the fallbacks.

/** Version sent to remote APIs; Nexus asks that it match the current release. */
export const APP_VERSION: string = process.env.LATTICE_VERSION || '0.1.0';

/** Name sent to remote APIs, the same across versions. */
export const APP_NAME = 'Lattice';

/**
 * Application slug issued by Nexus Mods after registration (support@nexusmods.com).
 * Empty in builds made before registration: then only a personal key works,
 * which Nexus allows for testing, not for a public release.
 */
export const NEXUS_SLUG: string = process.env.LATTICE_NEXUS_SLUG || '';

/** CurseForge API key issued to Lattice (console.curseforge.com); empty in builds without one. */
export const CURSEFORGE_KEY: string = process.env.LATTICE_CURSEFORGE_KEY || '';
