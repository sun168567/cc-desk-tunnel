// Every catalog, by language and namespace. A namespace is one part of the program's text; adding one is a file
// in each language's folder and a line for each here.
import zhCommon from './locales/zh-CN/common.json' with { type: 'json' };
import enCommon from './locales/en/common.json' with { type: 'json' };

export const namespaces = ['common'] as const;
export const catalogs = {
  'zh-CN': { common: zhCommon },
  en: { common: enCommon },
} as const;
