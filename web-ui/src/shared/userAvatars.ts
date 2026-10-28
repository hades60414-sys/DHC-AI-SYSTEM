import { useSyncExternalStore } from 'react';

import { readUserPreference, subscribeToUserPreferences, writeUserPreference } from '@/shared/userSettings';

/**
 * DHC CLI 頭像: the avatar is a setting of this device's profile (專案設定), like the theme and language, so
 * switching profile switches the face. It is the `userAvatar` preference ('' = the default 「U」), stored on the
 * server per profile and shown beside every user message on this device.
 */
const readAvatar = (): string | null => readUserPreference<string>('userAvatar', '') || null;

export function useUserAvatar(): string | null {
  return useSyncExternalStore(subscribeToUserPreferences, readAvatar, () => null);
}

/** null goes back to 「U」. */
export function setUserAvatar(avatarId: string | null): void {
  writeUserPreference('userAvatar', avatarId ?? '');
}
