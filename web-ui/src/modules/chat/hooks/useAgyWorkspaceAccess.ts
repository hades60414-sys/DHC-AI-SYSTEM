import { useEffect, useState } from 'react';

import { api } from '@/shared/api';

export type AgyWorkspaceAccess = {
  /** False until the server has said yes, so the tab is never usable by default. */
  allowed: boolean;
  reason: string | null;
  loading: boolean;
};

const PENDING: AgyWorkspaceAccess = { allowed: false, reason: null, loading: true };

/**
 * Parses `GET /api/providers/agy/workspace-access`. Anything unexpected counts
 * as "not allowed", because Google agy sends content to Google without
 * de-identification.
 */
export function parseAgyWorkspaceAccess(payload: unknown): AgyWorkspaceAccess {
  const data = (payload as { data?: { allowed?: unknown; reason?: unknown } } | null)?.data;
  if (data?.allowed === true) {
    return { allowed: true, reason: null, loading: false };
  }
  return {
    allowed: false,
    reason: typeof data?.reason === 'string' && data.reason ? data.reason : '無法確認這個專案是否在 Google agy 白名單內。',
    loading: false,
  };
}

/** Used by the chat composer and the provider picker to decide whether Google agy may be used in a project. */
export function useAgyWorkspaceAccess(projectPath: string | null | undefined): AgyWorkspaceAccess {
  const [access, setAccess] = useState<AgyWorkspaceAccess>(PENDING);

  useEffect(() => {
    if (!projectPath) {
      setAccess({ allowed: false, reason: '尚未選擇專案。', loading: false });
      return undefined;
    }

    let cancelled = false;
    setAccess(PENDING);
    api.agyWorkspaceAccess(projectPath)
      .then(async (response) => (response.ok ? parseAgyWorkspaceAccess(await response.json()) : parseAgyWorkspaceAccess(null)))
      .catch(() => parseAgyWorkspaceAccess(null))
      .then((next) => {
        if (!cancelled) {
          setAccess(next);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  return access;
}
