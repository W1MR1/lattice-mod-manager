import { describe, expect, it } from 'vitest';
import { bepinexMapper, safeRel } from '../electron/core/installer';
import { parseDependency } from '../electron/core/sources/thunderstore';

describe('safeRel', () => {
  it('refuses paths that escape the target folder', () => {
    expect(safeRel('../evil.dll')).toBeNull();
    expect(safeRel('a/../../evil.dll')).toBeNull();
    expect(safeRel('C:/Windows/evil.dll')).toBeNull();
    expect(safeRel('/abs/ok.txt')).toBe('abs/ok.txt');
    expect(safeRel('plugins\\x.dll')).toBe('plugins/x.dll');
  });
});

describe('bepinexMapper', () => {
  const names = ['manifest.json', 'icon.png', 'plugins/Foo.dll', 'config/foo.cfg', 'Bar.dll', 'BepInEx/patchers/P.dll'];
  it('lays out a regular package like r2modman', () => {
    const map = bepinexMapper('Author-Foo', names, false);
    expect(map('plugins/Foo.dll')).toBe('BepInEx/plugins/Author-Foo/Foo.dll');
    expect(map('config/foo.cfg')).toBe('BepInEx/config/foo.cfg');
    expect(map('Bar.dll')).toBe('BepInEx/plugins/Author-Foo/Bar.dll');
    expect(map('BepInEx/patchers/P.dll')).toBe('BepInEx/patchers/Author-Foo/P.dll');
  });

  it('unpacks BepInExPack into the game root', () => {
    const pack = ['BepInExPack/winhttp.dll', 'BepInExPack/doorstop_config.ini', 'BepInExPack/BepInEx/core/BepInEx.dll', 'README.md'];
    const map = bepinexMapper('BepInEx-BepInExPack', pack, true);
    expect(map('BepInExPack/winhttp.dll')).toBe('winhttp.dll');
    expect(map('BepInExPack/BepInEx/core/BepInEx.dll')).toBe('BepInEx/core/BepInEx.dll');
    expect(map('README.md')).toBeNull();
  });
});

describe('parseDependency', () => {
  it('splits Thunderstore dependency strings', () => {
    expect(parseDependency('BepInEx-BepInExPack-5.4.2100')).toEqual({ projectId: 'BepInEx-BepInExPack', version: '5.4.2100' });
    expect(parseDependency('Some-Mod_Name-1.0.0')).toEqual({ projectId: 'Some-Mod_Name', version: '1.0.0' });
    expect(parseDependency('broken')).toBeNull();
  });
});
