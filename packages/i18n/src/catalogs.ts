// Every catalog, by language and namespace. A namespace is one part of the program's text; adding one is a file
// in each language's folder and a line for each here.
import zhCommon from './locales/zh-CN/common.json' with { type: 'json' };
import zhConnection from './locales/zh-CN/connection.json' with { type: 'json' };
import zhService from './locales/zh-CN/service.json' with { type: 'json' };
import enCommon from './locales/en/common.json' with { type: 'json' };
import enConnection from './locales/en/connection.json' with { type: 'json' };
import enService from './locales/en/service.json' with { type: 'json' };

// common: words used all over the window
// connection: connecting and signing in, requests and their failures
// service: what the service says, sent as phrases (see src/phrase.ts)
export const namespaces = ['common', 'connection', 'service'] as const;
export const catalogs = {
  'zh-CN': { common: zhCommon, connection: zhConnection, service: zhService },
  en: { common: enCommon, connection: enConnection, service: enService },
} as const;
