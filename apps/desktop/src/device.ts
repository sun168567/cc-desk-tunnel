import type { Device, Session } from '@cc-desk-tunnel/protocol';

// Which of the user's computers this is to the service. The desktop keeps the identity with its settings; a
// browser, which only ever meets the simulation service, keeps one of its own.
export async function thisDevice(): Promise<Device> {
  if (window.desktop) return window.desktop.device();
  const id = localStorage.getItem('proxy-device') ?? crypto.randomUUID();
  localStorage.setItem('proxy-device', id);
  return { id, name: '浏览器' };
}
// A session is on this computer when its project directory is; one from before computers were told apart
// is on whichever uses it first.
export function isHere(session: Session, device: Device | null) {
  return !session.device || session.device.id === device?.id;
}
