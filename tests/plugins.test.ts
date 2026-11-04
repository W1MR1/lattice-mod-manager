import { describe, expect, it } from 'vitest';
import { checkCompatibility } from '../electron/core/compat';
import { buildPluginsTxt, parsePluginsTxt, readMasters } from '../electron/core/plugins';
import { parseNexusUrl, parseNxm } from '../electron/core/sources/nexus';
import { installed, profile, ver } from './fixtures';

function sub(type: string, data: Buffer): Buffer {
  const h = Buffer.alloc(6);
  h.write(type, 0, 'latin1');
  h.writeUInt16LE(data.length, 4);
  return Buffer.concat([h, data]);
}

/** A minimal Skyrim SE plugin header: TES4 record with HEDR and MAST/DATA pairs. */
function tes4(masters: string[]): Buffer {
  const body = Buffer.concat([
    sub('HEDR', Buffer.alloc(12)),
    sub('CNAM', Buffer.from('author\0', 'latin1')),
    ...masters.flatMap((m) => [sub('MAST', Buffer.from(`${m}\0`, 'latin1')), sub('DATA', Buffer.alloc(8))]),
  ]);
  const head = Buffer.alloc(24);
  head.write('TES4', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, Buffer.from('GRUP....', 'latin1')]);
}

describe('plugins', () => {
  it('reads master files from a TES4 header', () => {
    expect(readMasters(tes4(['Skyrim.esm', 'Update.esm', 'SkyUI_SE.esp']))).toEqual(['Skyrim.esm', 'Update.esm', 'SkyUI_SE.esp']);
    expect(readMasters(Buffer.from('not a plugin at all, definitely not'))).toEqual([]);
  });

  it('keeps foreign entries, drops plugins Lattice removed, and puts masters first', () => {
    const existing = parsePluginsTxt('# comment\r\n*Foreign.esp\r\nDisabled.esp\r\n*Old.esp\r\n');
    const txt = buildPluginsTxt(existing, ['Lib.esm', 'Mine.esp'], ['Old.esp']);
    const lines = txt.split('\r\n').filter((l) => l && !l.startsWith('#'));
    expect(lines).toEqual(['*Lib.esm', '*Foreign.esp', 'Disabled.esp', '*Mine.esp']);
  });

  it('reports a plugin whose master is missing as a compatibility error', () => {
    const a = installed(ver('a', '1.0'));
    const r = checkCompatibility(profile([a]), [], [], {
      plugins: [{ owner: 'modrinth:a', name: 'A.esp', masters: ['Skyrim.esm', 'Missing.esm'] }],
      available: ['Skyrim.esm'],
    });
    expect(r.issues.map((i) => i.code)).toEqual(['missing-master']);
    expect(r.issues[0].message).toContain('Missing.esm');
  });
});

describe('Nexus links', () => {
  it('parses nxm:// links from "Mod Manager Download"', () => {
    expect(parseNxm('nxm://skyrimspecialedition/mods/12604/files/35407?key=abc&expires=1800000000&user_id=1')).toEqual({
      domain: 'skyrimspecialedition',
      modId: 12604,
      fileId: 35407,
      key: 'abc',
      expires: 1800000000,
    });
    expect(parseNxm('https://example.com')).toBeNull();
    expect(parseNexusUrl('nexus://fallout4/1/2')).toEqual({ domain: 'fallout4', modId: 1, fileId: 2 });
  });
});
