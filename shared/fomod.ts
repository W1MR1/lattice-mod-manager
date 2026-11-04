// FOMOD installer model and its evaluation. Shared so the installer wizard in
// the UI shows exactly the steps, defaults and files the main process installs.

export type FomodPluginType = 'Required' | 'Recommended' | 'Optional' | 'NotUsable' | 'CouldBeUsable';
export type FomodGroupType = 'SelectExactlyOne' | 'SelectAtMostOne' | 'SelectAtLeastOne' | 'SelectAll' | 'SelectAny';

export interface FomodFileRef {
  source: string;
  destination: string;
  priority: number;
  folder: boolean;
}

export interface FomodCondition {
  op: 'And' | 'Or';
  flags: { flag: string; value: string }[];
  files: { file: string; state: 'Active' | 'Inactive' | 'Missing' }[];
  children: FomodCondition[];
}

export interface FomodPlugin {
  name: string;
  description: string;
  image?: string;
  files: FomodFileRef[];
  flags: { name: string; value: string }[];
  defaultType: FomodPluginType;
  patterns: { when: FomodCondition; type: FomodPluginType }[];
}

export interface FomodGroup {
  name: string;
  type: FomodGroupType;
  plugins: FomodPlugin[];
}

export interface FomodStep {
  name: string;
  visible?: FomodCondition;
  groups: FomodGroup[];
}

export interface FomodConfig {
  moduleName: string;
  /** archive folder that holds `fomod/` (sources are relative to it) */
  root: string;
  required: FomodFileRef[];
  steps: FomodStep[];
  conditional: { when: FomodCondition; files: FomodFileRef[] }[];
}

/** step name -> group name -> chosen plugin names */
export type FomodChoices = Record<string, Record<string, string[]>>;

/** Plugin file state in the current load order, for fileDependency conditions. */
export type FileState = (file: string) => 'Active' | 'Inactive' | 'Missing';

export const noFiles: FileState = () => 'Missing';

export function evalCondition(c: FomodCondition | undefined, flags: Map<string, string>, fileState: FileState): boolean {
  if (!c) return true;
  const results = [
    ...c.flags.map((f) => (flags.get(f.flag) ?? '') === f.value),
    ...c.files.map((f) => fileState(f.file) === f.state),
    ...c.children.map((ch) => evalCondition(ch, flags, fileState)),
  ];
  if (results.length === 0) return true;
  return c.op === 'Or' ? results.some(Boolean) : results.every(Boolean);
}

export function pluginType(p: FomodPlugin, flags: Map<string, string>, fileState: FileState): FomodPluginType {
  for (const pat of p.patterns) if (evalCondition(pat.when, flags, fileState)) return pat.type;
  return p.defaultType;
}

/** Default selection for one group, as the FOMOD spec describes it. */
function groupDefault(g: FomodGroup, flags: Map<string, string>, fileState: FileState): string[] {
  const typed = g.plugins.map((p) => ({ p, t: pluginType(p, flags, fileState) }));
  const usable = typed.filter((x) => x.t !== 'NotUsable');
  const pick = typed.filter((x) => x.t === 'Required' || x.t === 'Recommended').map((x) => x.p.name);
  switch (g.type) {
    case 'SelectAll':
      return usable.map((x) => x.p.name);
    case 'SelectExactlyOne':
      return [pick[0] ?? usable[0]?.p.name].filter(Boolean) as string[];
    case 'SelectAtMostOne':
      return pick.slice(0, 1);
    case 'SelectAtLeastOne':
      return pick.length ? pick : ([usable[0]?.p.name].filter(Boolean) as string[]);
    default:
      return pick;
  }
}

/**
 * Walks the steps in order: a step is shown only when its condition holds for
 * the flags set by choices in earlier steps. Missing groups get defaults.
 */
export function walkSteps(
  config: FomodConfig,
  choices: FomodChoices,
  fileState: FileState = noFiles,
): { visible: FomodStep[]; flags: Map<string, string>; choices: FomodChoices } {
  const flags = new Map<string, string>();
  const visible: FomodStep[] = [];
  const out: FomodChoices = {};
  for (const step of config.steps) {
    if (!evalCondition(step.visible, flags, fileState)) continue;
    visible.push(step);
    out[step.name] = {};
    for (const g of step.groups) {
      const chosen = choices[step.name]?.[g.name] ?? groupDefault(g, flags, fileState);
      const valid = chosen.filter((n) => {
        const p = g.plugins.find((x) => x.name === n);
        return p && pluginType(p, flags, fileState) !== 'NotUsable';
      });
      // Required plugins are always part of the selection.
      for (const p of g.plugins) if (pluginType(p, flags, fileState) === 'Required' && !valid.includes(p.name)) valid.push(p.name);
      out[step.name][g.name] = valid;
      for (const n of valid) for (const f of g.plugins.find((x) => x.name === n)!.flags) flags.set(f.name, f.value);
    }
  }
  return { visible, flags, choices: out };
}

export function defaultChoices(config: FomodConfig, fileState: FileState = noFiles): FomodChoices {
  return walkSteps(config, {}, fileState).choices;
}

/** Human-readable problems with a selection (empty when it is valid). */
export function validateChoices(config: FomodConfig, choices: FomodChoices, fileState: FileState = noFiles): string[] {
  const { visible } = walkSteps(config, choices, fileState);
  const errors: string[] = [];
  for (const step of visible) {
    for (const g of step.groups) {
      const n = choices[step.name]?.[g.name]?.length ?? 0;
      if (g.type === 'SelectExactlyOne' && n !== 1) errors.push(`«${step.name} / ${g.name}»: нужно выбрать ровно один вариант`);
      if (g.type === 'SelectAtLeastOne' && n < 1) errors.push(`«${step.name} / ${g.name}»: нужен хотя бы один вариант`);
      if (g.type === 'SelectAtMostOne' && n > 1) errors.push(`«${step.name} / ${g.name}»: не больше одного варианта`);
    }
  }
  return errors;
}

/** Files to install for a selection: required ones, chosen plugins, matching conditional installs. */
export function resolveFiles(config: FomodConfig, choices: FomodChoices, fileState: FileState = noFiles): FomodFileRef[] {
  const { visible, flags, choices: full } = walkSteps(config, choices, fileState);
  const files: FomodFileRef[] = [...config.required];
  for (const step of visible) {
    for (const g of step.groups) {
      for (const name of full[step.name]?.[g.name] ?? []) {
        const p = g.plugins.find((x) => x.name === name);
        if (p) files.push(...p.files);
      }
    }
  }
  for (const c of config.conditional) if (evalCondition(c.when, flags, fileState)) files.push(...c.files);
  // Stable by priority: higher priority is copied later and wins.
  return files.map((f, i) => ({ f, i })).sort((a, b) => a.f.priority - b.f.priority || a.i - b.i).map((x) => x.f);
}
