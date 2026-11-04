// Parses FOMOD installers (fomod/ModuleConfig.xml, schema 5.x) into the
// shared model. Many archives ship the XML as UTF-16, so the BOM decides.
import { XMLParser } from 'fast-xml-parser';
import type {
  FomodCondition,
  FomodConfig,
  FomodFileRef,
  FomodGroup,
  FomodGroupType,
  FomodPlugin,
  FomodPluginType,
  FomodStep,
} from '../../shared/fomod';
import { t } from '../../shared/i18n';

type Node = Record<string, unknown>;

const ARRAYS = new Set([
  'file', 'folder', 'installStep', 'group', 'plugin', 'flag', 'pattern', 'flagDependency', 'fileDependency', 'dependencies',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  trimValues: true,
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (name) => ARRAYS.has(name),
});

export function decodeXml(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  // UTF-16 without BOM: every other byte of "<?xml" is zero
  if (buf.length > 4 && buf[1] === 0 && buf[3] === 0) return buf.toString('utf16le');
  return buf.toString('utf8');
}

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v === undefined || v === null ? [] : [v as T]);
const attr = (n: unknown, name: string): string => {
  const v = (n as Node | undefined)?.[`@${name}`];
  return v === undefined || v === null ? '' : String(v);
};
const text = (n: unknown): string => {
  if (n === undefined || n === null) return '';
  if (typeof n === 'string' || typeof n === 'number') return String(n);
  return String((n as Node)['#text'] ?? '');
};

const PLUGIN_TYPES: FomodPluginType[] = ['Required', 'Recommended', 'Optional', 'NotUsable', 'CouldBeUsable'];
const GROUP_TYPES: FomodGroupType[] = ['SelectExactlyOne', 'SelectAtMostOne', 'SelectAtLeastOne', 'SelectAll', 'SelectAny'];

function pluginTypeOf(v: string): FomodPluginType {
  return (PLUGIN_TYPES.find((t) => t.toLowerCase() === v.toLowerCase()) ?? 'Optional') as FomodPluginType;
}

function files(n: unknown): FomodFileRef[] {
  const node = (n ?? {}) as Node;
  const mk = (f: unknown, folder: boolean): FomodFileRef => {
    const source = attr(f, 'source').replace(/\\/g, '/');
    const dest = attr(f, 'destination');
    return {
      source,
      // an absent destination means "same path as the source"
      destination: ((f as Node)['@destination'] === undefined ? source : dest).replace(/\\/g, '/'),
      priority: Number(attr(f, 'priority')) || 0,
      folder,
    };
  };
  return [...arr(node.file).map((f) => mk(f, false)), ...arr(node.folder).map((f) => mk(f, true))];
}

function condition(n: unknown): FomodCondition | undefined {
  if (!n || typeof n !== 'object') return undefined;
  const node = n as Node;
  return {
    op: attr(node, 'operator') === 'Or' ? 'Or' : 'And',
    flags: arr(node.flagDependency).map((f) => ({ flag: attr(f, 'flag'), value: attr(f, 'value') })),
    files: arr(node.fileDependency).map((f) => ({ file: attr(f, 'file'), state: (attr(f, 'state') || 'Active') as 'Active' | 'Inactive' | 'Missing' })),
    children: arr(node.dependencies)
      .map(condition)
      .filter((c): c is FomodCondition => !!c),
  };
}

function ordered<T extends { name: string }>(items: T[], order: string): T[] {
  if (order === 'Explicit') return items;
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
  return order === 'Descending' ? sorted.reverse() : sorted;
}

function plugin(n: unknown): FomodPlugin {
  const node = n as Node;
  const td = (node.typeDescriptor ?? {}) as Node;
  const dep = td.dependencyType as Node | undefined;
  return {
    name: attr(node, 'name'),
    description: text(node.description).trim(),
    image: attr(node.image, 'path') || undefined,
    files: files(node.files),
    flags: arr((node.conditionFlags as Node | undefined)?.flag).map((f) => ({ name: attr(f, 'name'), value: text(f) })),
    defaultType: pluginTypeOf(dep ? attr(dep.defaultType, 'name') : attr(td.type, 'name')),
    patterns: dep
      ? arr((dep.patterns as Node | undefined)?.pattern).map((p) => ({
          when: condition((p as Node).dependencies ? arr((p as Node).dependencies)[0] : undefined) ?? { op: 'And', flags: [], files: [], children: [] },
          type: pluginTypeOf(attr((p as Node).type, 'name')),
        }))
      : [],
  };
}

export function parseFomod(xml: string, root: string): FomodConfig {
  const doc = parser.parse(xml) as Node;
  const config = (doc.config ?? doc) as Node;
  const stepsNode = (config.installSteps ?? {}) as Node;
  const steps: FomodStep[] = ordered(
    arr(stepsNode.installStep).map((s) => {
      const sn = s as Node;
      const groupsNode = (sn.optionalFileGroups ?? {}) as Node;
      const groups: FomodGroup[] = ordered(
        arr(groupsNode.group).map((g) => {
          const gn = g as Node;
          const pluginsNode = (gn.plugins ?? {}) as Node;
          const type = attr(gn, 'type');
          return {
            name: attr(gn, 'name'),
            type: (GROUP_TYPES.find((t) => t === type) ?? 'SelectAny') as FomodGroupType,
            plugins: ordered(arr(pluginsNode.plugin).map(plugin), attr(pluginsNode, 'order') || 'Ascending'),
          };
        }),
        attr(groupsNode, 'order') || 'Ascending',
      );
      return { name: attr(sn, 'name'), visible: condition(sn.visible), groups };
    }),
    attr(stepsNode, 'order') || 'Ascending',
  );
  const cond = (config.conditionalFileInstalls ?? {}) as Node;
  return {
    moduleName: text(config.moduleName).trim() || t('Установщик'),
    root,
    required: files(config.requiredInstallFiles),
    steps,
    conditional: arr((cond.patterns as Node | undefined)?.pattern).map((p) => ({
      when: condition(arr((p as Node).dependencies)[0]) ?? { op: 'And', flags: [], files: [], children: [] },
      files: files((p as Node).files),
    })),
  };
}

/** Finds `fomod/ModuleConfig.xml` among archive entries; returns its path and the folder above `fomod/`. */
export function findFomod(names: string[]): { entry: string; root: string } | null {
  const entry = names.find((n) => /(^|\/)fomod\/moduleconfig\.xml$/i.test(n));
  if (!entry) return null;
  const root = entry.replace(/fomod\/moduleconfig\.xml$/i, '');
  return { entry, root };
}
