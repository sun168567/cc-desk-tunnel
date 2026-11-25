import 'i18next';
import type { Resources } from './resources.d.ts';

// The catalogs' keys and the values each message is filled in with, checked wherever a message is used.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: Resources;
    returnNull: false;
    // The formats of lists (createI18n) take a list, or one item alone.
    interpolationFormatTypeMap: Record<
      'quoted' | 'clauses' | 'parts' | 'series' | 'commas',
      string | readonly string[]
    >;
  }
}
