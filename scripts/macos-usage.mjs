import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createI18n } from '@cc-desk-tunnel/i18n';

// What macOS shows when a command first reaches into one of these places, in the system's language. Info.plist
// says it in English, the application's own language (Electron's development region); the system takes the
// Chinese of InfoPlist.strings when it prefers Chinese, from the folders of Electron's own Chinese resources: of
// any region, as the program reads Chinese (packages/i18n).
export function usageDescriptions(language) {
  const { t } = createI18n(language);
  return {
    NSDesktopFolderUsageDescription: t('desktop:macos.desktop'),
    NSDocumentsFolderUsageDescription: t('desktop:macos.documents'),
    NSDownloadsFolderUsageDescription: t('desktop:macos.downloads'),
    NSRemovableVolumesUsageDescription: t('desktop:macos.removable'),
    NSNetworkVolumesUsageDescription: t('desktop:macos.network'),
  };
}
const chinese = ['zh_CN.lproj', 'zh_TW.lproj'];
const quoted = (text) => `"${text.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\n')}"`;
// The text of an InfoPlist.strings file that says these descriptions.
export const infoPlistStrings = (descriptions) =>
  Object.entries(descriptions)
    .map(([key, text]) => `${quoted(key)} = ${quoted(text)};\n`)
    .join('');
// Writes the Chinese InfoPlist.strings under `directory`; what electron-builder copies into Contents/Resources.
export function usageResources(directory) {
  const text = infoPlistStrings(usageDescriptions('zh-CN'));
  return chinese.map((folder) => {
    mkdirSync(join(directory, folder), { recursive: true });
    writeFileSync(join(directory, folder, 'InfoPlist.strings'), text);
    return {
      from: join(directory, folder, 'InfoPlist.strings'),
      to: `${folder}/InfoPlist.strings`,
    };
  });
}
