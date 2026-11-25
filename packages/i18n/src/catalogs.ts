// Every catalog, by language and namespace. A namespace is one part of the program's text; adding one is a file
// in each language's folder and a line for each here.
import zhCommon from './locales/zh-CN/common.json' with { type: 'json' };
import zhAccount from './locales/zh-CN/account.json' with { type: 'json' };
import zhConnection from './locales/zh-CN/connection.json' with { type: 'json' };
import zhFiles from './locales/zh-CN/files.json' with { type: 'json' };
import zhNav from './locales/zh-CN/nav.json' with { type: 'json' };
import zhSchedules from './locales/zh-CN/schedules.json' with { type: 'json' };
import zhService from './locales/zh-CN/service.json' with { type: 'json' };
import zhSession from './locales/zh-CN/session.json' with { type: 'json' };
import zhSettings from './locales/zh-CN/settings.json' with { type: 'json' };
import enCommon from './locales/en/common.json' with { type: 'json' };
import enAccount from './locales/en/account.json' with { type: 'json' };
import enConnection from './locales/en/connection.json' with { type: 'json' };
import enFiles from './locales/en/files.json' with { type: 'json' };
import enNav from './locales/en/nav.json' with { type: 'json' };
import enSchedules from './locales/en/schedules.json' with { type: 'json' };
import enService from './locales/en/service.json' with { type: 'json' };
import enSession from './locales/en/session.json' with { type: 'json' };
import enSettings from './locales/en/settings.json' with { type: 'json' };

// common: words used all over the window
// account: the Claude account, its quota and usage, the call log and the run stats
// connection: connecting and signing in, requests and their failures
// files: the file panel
// nav: the window frame: sidebar, rail, title bar, notifications
// schedules: scheduled tasks: their file, editor and runs
// service: what the service says, sent as phrases (see src/phrase.ts)
// session: a session: the conversation, its runs, tools and controls
// settings: the settings pages, and the setting fields shared with ccdt
export const namespaces = [
  'common',
  'account',
  'connection',
  'files',
  'nav',
  'schedules',
  'service',
  'session',
  'settings',
] as const;
export const catalogs = {
  'zh-CN': {
    common: zhCommon,
    account: zhAccount,
    connection: zhConnection,
    files: zhFiles,
    nav: zhNav,
    schedules: zhSchedules,
    service: zhService,
    session: zhSession,
    settings: zhSettings,
  },
  en: {
    common: enCommon,
    account: enAccount,
    connection: enConnection,
    files: enFiles,
    nav: enNav,
    schedules: enSchedules,
    service: enService,
    session: enSession,
    settings: enSettings,
  },
} as const;
