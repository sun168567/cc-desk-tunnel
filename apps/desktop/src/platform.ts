// The system the desktop window runs on, where the page has to know it: the names of things the user sees,
// the keys of the keyboard, and what the client can do there. The Vite development page has no desktop host.
export const isMac = typeof window !== 'undefined' && window.desktop?.platform === 'darwin';
// Only the Windows installer can be run over an installation; elsewhere a new package is installed by hand.
// The production browser installs its remote host after these modules load; the development page does not.
export const selfUpdating =
  typeof window === 'undefined' ||
  (!window.desktop && import.meta.env.DEV) ||
  (!!window.desktop && !window.desktop.remote && window.desktop.platform === 'win32');
