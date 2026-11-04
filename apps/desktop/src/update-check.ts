import type { ServiceUpdate } from '@cc-desk-tunnel/protocol';

// The service looks for a new release by itself every six hours. While someone uses a client, the client asks it to
// look again once its last look is an hour old, so that a release shows within the hour for whoever is there. Any
// number of clients ask no more often than one does: each goes by when the service last looked.
export const UPDATE_LOOK_MS = 3_600_000;
// How often a client in use sees whether it is time.
export const UPDATE_TICK_MS = 600_000;
export const lookDue = (update: ServiceUpdate | null | undefined, now: number) =>
  !!update &&
  !['checking', 'installing', 'restarting'].includes(update.state) &&
  now - (update.checkedAt ?? 0) >= UPDATE_LOOK_MS;
