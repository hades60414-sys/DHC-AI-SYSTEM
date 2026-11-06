import { useCallback, useEffect, useState } from 'react';

import { officeRequest } from '@/shared/api';

/**
 * office 模組內部：讀取 API 並提供 loading／error／reload。path 一律來自 `officeEndpoints`（src/shared/api.ts）。
 * loading 由「目前請求 key 是否已完成」推導，effect 內只在非同步回呼更新狀態。
 *
 * V5.2 ASTRA-ROLL-002：data 只屬於取得它的 path。切換到另一個資源（path 改變）時，在新資源回應前 data＝null，
 * 失敗時也不會沿用前一個資源的 data（同一資源重新載入失敗時保留原資料，但 ready＝false）。
 * 寫入／審批只能在 ready（本 path 已完成、無錯誤、有資料）時進行；呼叫端仍須在動作當下核對資料自身的 id。
 */
export function useOfficeQuery<T>(path: string | null) {
  const [version, setVersion] = useState(0);
  const [result, setResult] = useState<{ key: string; path: string; data: T | null; error: string | null } | null>(null);
  const key = path ? `${path}#${version}` : null;

  useEffect(() => {
    if (!path || !key) return undefined;
    let cancelled = false;
    officeRequest<T>(path)
      .then(data => { if (!cancelled) setResult({ key, path, data, error: null }); })
      .catch((reason: Error) => {
        if (!cancelled) setResult(current => ({ key, path, data: current?.path === path ? current.data : null, error: reason.message }));
      });
    return () => { cancelled = true; };
  }, [path, key]);

  const reload = useCallback(() => setVersion(value => value + 1), []);
  const settled = result?.key === key;
  const data = path && result?.path === path ? result.data : null;
  const error = settled ? result?.error ?? null : null;
  return {
    data,
    error,
    loading: Boolean(key) && !settled,
    /** 本 path 的請求已完成、沒有錯誤、且有資料：只有此時可以寫入或審批。 */
    ready: settled && !error && data !== null,
    path,
    reload,
  };
}
