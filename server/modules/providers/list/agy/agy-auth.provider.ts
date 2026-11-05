import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AGY_EXECUTABLE_PATH } from '@/modules/providers/list/agy/agy-runtime.provider.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';

/**
 * agy has no cheap non-interactive "whoami", so installed = the executable exists
 * and signed in = the CLI's own state folder exists (created by its Google login).
 * An expired login only shows up when a turn runs.
 */
export class AgyProviderAuth implements IProviderAuth {
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = existsSync(AGY_EXECUTABLE_PATH);
    const signedIn = existsSync(path.join(os.homedir(), '.gemini', 'antigravity-cli', 'installation_id'));
    return {
      installed,
      provider: 'agy',
      authenticated: installed && signedIn,
      email: signedIn ? 'Google 帳號（agy）' : null,
      method: signedIn ? 'agy_login' : null,
      error: !installed
        ? `找不到 agy 執行檔：${AGY_EXECUTABLE_PATH}`
        : signedIn ? undefined : 'agy 尚未登入 Google（在主機上執行 agy 登入）',
    };
  }
}
