export function consumePairingLink(
  location: Pick<Location, 'href'>,
  history: Pick<History, 'state' | 'replaceState'>,
): string | null {
  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  if (!fragment.has('pair')) return null;
  const token = fragment.get('pair')?.trim() ?? '';
  fragment.delete('pair');
  url.hash = fragment.toString();
  // Clear the fragment before any authentication request, including failed attempts.
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return token;
}
