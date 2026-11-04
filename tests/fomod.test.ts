import { describe, expect, it } from 'vitest';
import { decodeXml, findFomod, parseFomod } from '../electron/core/fomod';
import { defaultChoices, resolveFiles, validateChoices, walkSteps } from '../shared/fomod';

export const SAMPLE_XML = `<?xml version="1.0" encoding="utf-16"?>
<config xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <moduleName>Тестовый мод</moduleName>
  <requiredInstallFiles>
    <file source="core\\Core.esp" destination="Core.esp" />
    <folder source="core\\textures" destination="textures" />
  </requiredInstallFiles>
  <installSteps order="Explicit">
    <installStep name="Вариант">
      <optionalFileGroups order="Explicit">
        <group name="Стиль" type="SelectExactlyOne">
          <plugins order="Explicit">
            <plugin name="Светлый">
              <description>Светлые текстуры</description>
              <files><file source="optA\\A.esp" destination="Style.esp" priority="1" /></files>
              <conditionFlags><flag name="style">light</flag></conditionFlags>
              <typeDescriptor><type name="Optional" /></typeDescriptor>
            </plugin>
            <plugin name="Тёмный">
              <description>Тёмные текстуры</description>
              <files><file source="optB\\B.esp" destination="Style.esp" priority="1" /></files>
              <conditionFlags><flag name="style">dark</flag></conditionFlags>
              <typeDescriptor><type name="Recommended" /></typeDescriptor>
            </plugin>
          </plugins>
        </group>
      </optionalFileGroups>
    </installStep>
    <installStep name="Только для тёмного">
      <visible><flagDependency flag="style" value="dark" /></visible>
      <optionalFileGroups>
        <group name="Дополнения" type="SelectAny">
          <plugins>
            <plugin name="Тени">
              <description>Глубокие тени</description>
              <files><file source="extra\\Shadows.esp" /></files>
              <typeDescriptor><type name="Optional" /></typeDescriptor>
            </plugin>
            <plugin name="Недоступный">
              <description>Нужен другой мод</description>
              <typeDescriptor>
                <dependencyType>
                  <defaultType name="NotUsable" />
                  <patterns>
                    <pattern>
                      <dependencies operator="And"><fileDependency file="Other.esp" state="Active" /></dependencies>
                      <type name="Optional" />
                    </pattern>
                  </patterns>
                </dependencyType>
              </typeDescriptor>
            </plugin>
          </plugins>
        </group>
      </optionalFileGroups>
    </installStep>
  </installSteps>
  <conditionalFileInstalls>
    <patterns>
      <pattern>
        <dependencies operator="And"><flagDependency flag="style" value="dark" /></dependencies>
        <files><file source="patches\\DarkPatch.esp" destination="DarkPatch.esp" /></files>
      </pattern>
    </patterns>
  </conditionalFileInstalls>
</config>`;

export function utf16(s: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
}

describe('FOMOD', () => {
  const config = parseFomod(decodeXml(utf16(SAMPLE_XML)), 'MyMod/');

  it('parses a UTF-16 ModuleConfig.xml with steps, groups and conditions', () => {
    expect(config.moduleName).toBe('Тестовый мод');
    expect(config.required.map((f) => f.source)).toEqual(['core/Core.esp', 'core/textures']);
    expect(config.steps.map((s) => s.name)).toEqual(['Вариант', 'Только для тёмного']);
    expect(config.steps[1].visible?.flags).toEqual([{ flag: 'style', value: 'dark' }]);
    // unordered plugins default to ascending order
    expect(config.steps[1].groups[0].plugins.map((p) => p.name)).toEqual(['Недоступный', 'Тени']);
  });

  it('picks recommended options and shows steps only when their flags are set', () => {
    const d = defaultChoices(config);
    expect(d['Вариант']['Стиль']).toEqual(['Тёмный']);
    expect(walkSteps(config, d).visible).toHaveLength(2);
    const light = { Вариант: { Стиль: ['Светлый'] } };
    expect(walkSteps(config, light).visible.map((s) => s.name)).toEqual(['Вариант']);
  });

  it('resolves files from the selection, conditional installs and dependency-typed plugins', () => {
    const dark = { Вариант: { Стиль: ['Тёмный'] }, 'Только для тёмного': { Дополнения: ['Тени', 'Недоступный'] } };
    const files = resolveFiles(config, dark).map((f) => f.destination);
    expect(files).toEqual(['Core.esp', 'textures', 'extra/Shadows.esp', 'DarkPatch.esp', 'Style.esp']);
    // "Недоступный" became usable only when Other.esp is active
    const withOther = walkSteps(config, dark, (f) => (f === 'Other.esp' ? 'Active' : 'Missing')).choices;
    expect(withOther['Только для тёмного']['Дополнения']).toEqual(['Тени', 'Недоступный']);
    const light = resolveFiles(config, { Вариант: { Стиль: ['Светлый'] } }).map((f) => f.source);
    expect(light).not.toContain('patches/DarkPatch.esp');
  });

  it('validates group rules', () => {
    expect(validateChoices(config, { Вариант: { Стиль: [] } })[0]).toMatch(/ровно один/);
    expect(validateChoices(config, defaultChoices(config))).toEqual([]);
  });

  it('finds the installer inside a nested folder', () => {
    expect(findFomod(['MyMod/readme.txt', 'MyMod/fomod/ModuleConfig.xml'])).toEqual({ entry: 'MyMod/fomod/ModuleConfig.xml', root: 'MyMod/' });
    expect(findFomod(['plugin.esp'])).toBeNull();
  });
});
