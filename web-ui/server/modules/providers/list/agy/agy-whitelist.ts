import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Google agy runs outside the company de-identification layer, so a project
 * may only use it when its path contains one of the fragments listed in this
 * file (one fragment per line, `#` starts a comment). It is the same file the
 * Claude-quota takeover script uses.
 */
export const AGY_WHITELIST_PATH =
  process.env.AGY_WHITELIST_PATH || path.join(os.homedir(), '.dhc', 'agy-whitelist.txt');

export type AgyWorkspaceAccess = { allowed: boolean; reason: string | null };

const normalizeForMatch = (value: string): string =>
  value.replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();

/** Parses the whitelist file body into path fragments. */
export function parseAgyWhitelist(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.replace(/^\uFEFF/, '').trim())
    .filter((line) => line && !line.startsWith('#'));
}

/** True when the project path contains any whitelist fragment (case/slash insensitive). */
export function isAgyWorkspaceAllowed(projectPath: string | null | undefined, fragments: string[]): boolean {
  if (!projectPath?.trim()) {
    return false;
  }

  const target = normalizeForMatch(projectPath);
  return fragments.some((fragment) => {
    const normalized = normalizeForMatch(fragment);
    return normalized.length > 0 && target.includes(normalized);
  });
}

/** Reads the whitelist from disk on every call so edits take effect without a restart. */
export async function checkAgyWorkspaceAccess(
  projectPath: string | null | undefined,
  whitelistPath: string = AGY_WHITELIST_PATH,
): Promise<AgyWorkspaceAccess> {
  let fragments: string[];
  try {
    fragments = parseAgyWhitelist(await readFile(whitelistPath, 'utf8'));
  } catch {
    return { allowed: false, reason: '讀不到 Google agy 白名單檔，為避免資料外送，一律不允許使用。' };
  }

  if (isAgyWorkspaceAllowed(projectPath, fragments)) {
    return { allowed: true, reason: null };
  }

  return {
    allowed: false,
    reason: '這個專案不在 Google agy 白名單內：內容會原文送到 Google、不經去識別，所以只允許白名單工作區使用。',
  };
}
