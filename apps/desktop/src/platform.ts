// The system the desktop window runs on, where the page has to know it: the names of things the user sees,
// the keys of the keyboard, and what the client can do there. A browser, which only meets the simulation
// service, is none of them.
export const isMac = typeof window !== 'undefined' && window.desktop?.platform === 'darwin';
// Only the Windows installer can be run over an installation; elsewhere a new package is installed by hand.
export const selfUpdating =
  typeof window === 'undefined' || !window.desktop || window.desktop.platform === 'win32';
export const canDownloadRelease = selfUpdating || isMac;
