import { useCallback, useEffect, useState } from 'react';

import { officeRequest } from '@/shared/api';

/**
 * office 模組內部：讀取 API 並提供 loading／error／reload。path 一律來自 `officeEndpoints`（src/shared/api.ts）。
 * loading 由「目前請求 key 是否已完成」推導，effect 內只在非同步回呼更新狀態。
 */
export function useOfficeQuery<T>(path: string | null) {
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{ key: string; data: T | null; error: string | null } | null>(null);
  const key = path ? `${path}#${version}` : null;

  useEffect(() => {
    if (!path || !key) return undefined;
    let cancelled = false;
    officeRequest<T>(path)
      .then(data => { if (!cancelled) setResult({ key, data, error: null }); })
      .catch((reason: Error) => { if (!cancelled) setResult(current => ({ key, data: current?.data ?? null, error: reason.message })); });
    return () => { cancelled = true; };
  }, [path, key]);

  const reload = useCallback(() => setVersion(value => value + 1), []);
  const settled = result?.key === key;
  return {
    data: path ? (result?.data ?? null) : null,
    error: settled ? result?.error ?? null : null,
    loading: Boolean(key) && !settled,
    reload,
  };
}
