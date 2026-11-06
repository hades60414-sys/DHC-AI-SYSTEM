/**
 * SEC-01 部署模式解析。供 server 入口在建立任何路由或 WS 之前呼叫；不合法組合直接丟錯讓行程不啟動（fail closed）。
 *
 * - personal（預設）：原 DHC 個人工作台。`VITE_IS_PLATFORM=true` 會讓所有請求對映到第一位使用者，
 *   因此只有同時設定 `DHC_ALLOW_PLATFORM_FIRST_USER=loopback-only` 且 HOST 為 loopback 時才允許。
 * - enterprise：只開放 `/api/enterprise/v1`；禁止 platform 模式；必須提供企業資料庫與 blob 根目錄設定。
 */
export type DeploymentMode = 'personal' | 'enterprise';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

export function resolveDeploymentMode(env: NodeJS.ProcessEnv): DeploymentMode {
  const raw = env.DHC_DEPLOYMENT_MODE ?? 'personal';
  if (raw !== 'personal' && raw !== 'enterprise') throw new Error('DHC_DEPLOYMENT_MODE must be "personal" or "enterprise"');
  // ASTRA-012：企業 image（DHC_IMAGE_PROFILE=enterprise）已移除個人模式依賴（Claude Agent SDK、桌面自動化等），只能以企業模式啟動。
  if (env.DHC_IMAGE_PROFILE === 'enterprise' && raw !== 'enterprise') throw new Error('This enterprise image only runs with DHC_DEPLOYMENT_MODE=enterprise');
  const platform = env.VITE_IS_PLATFORM === 'true';
  if (raw === 'enterprise') {
    if (platform) throw new Error('Enterprise mode refuses VITE_IS_PLATFORM=true (first-user fallback is not allowed)');
    for (const key of ['ENTERPRISE_DB_HOST', 'ENTERPRISE_DB_NAME', 'ENTERPRISE_DB_PASSWORD', 'ENTERPRISE_BLOB_ROOT']) {
      if (!env[key]) throw new Error(`Enterprise mode requires ${key}`);
    }
    if (env.ENTERPRISE_DB_USER !== 'dhc_app') throw new Error('Enterprise mode must connect as the restricted dhc_app role');
    return 'enterprise';
  }
  if (platform) {
    const host = env.HOST || '127.0.0.1';
    if (env.DHC_ALLOW_PLATFORM_FIRST_USER !== 'loopback-only' || !LOOPBACK_HOSTS.has(host)) {
      throw new Error('VITE_IS_PLATFORM=true requires DHC_ALLOW_PLATFORM_FIRST_USER=loopback-only and a loopback HOST');
    }
  }
  return 'personal';
}
