import { platformOf } from '@cc-desk-tunnel/protocol';
import type { Device, Session } from '@cc-desk-tunnel/protocol';
import { pathKey } from './paths.ts';

// Which of the user's computers this is to the service. The desktop keeps the identity with its settings; a
// browser, which only ever meets the simulation service, keeps one of its own.
export async function thisDevice(): Promise<Device> {
  if (window.desktop) {
    const { platform } = window.desktop;
    return { ...(await window.desktop.device()), ...(platform === 'win32' ? {} : { platform }) };
  }
  const id = localStorage.getItem('proxy-device') ?? crypto.randomUUID();
  localStorage.setItem('proxy-device', id);
  return { id, name: '浏览器' };
}
// A session is on this computer when its project directory is; one from before computers were told apart
// is on whichever uses it first. Until then it is taken to be here, unless its folder was looked for on this
// computer and not found: `absent` holds those folders by pathKey().
export function isHere(session: Session, device: Device | null, absent?: ReadonlySet<string>) {
  // Before computers were told apart they were all Windows ones.
  if (!session.device)
    return platformOf(device) === 'win32' && !absent?.has(pathKey(session.projectPath));
  return session.device.id === device?.id;
}
