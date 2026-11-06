import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/shared/ui';
import { OfficeAudit, OfficeMembers, OfficeModels, OfficeSubscription } from '@/modules/office/OfficeAdmin';
import { OfficeDocuments } from '@/modules/office/OfficeDocuments';
import { OfficeLogin } from '@/modules/office/OfficeLogin';
import { OfficeNotifications } from '@/modules/office/OfficeNotifications';
import { OfficeReconciliation } from '@/modules/office/OfficeReconciliation';
import { OfficeStatus } from '@/modules/office/OfficeStatus';
import { OfficeApprovals, OfficeDrafts, OfficeSearch } from '@/modules/office/OfficeWork';
import { officeApi, readOfficeSession, writeOfficeSession } from '@/shared/api';
import type { OfficeIdentity } from '@/shared/types';

/** permission 為 null 的分頁所有成員都看得到。 */
type Tab = { key: string; label: string; permission: string | null };
const TABS: Tab[] = [
  { key: 'documents', label: '文件', permission: 'documents.read' },
  { key: 'search', label: '檢索與引用', permission: 'documents.read' },
  { key: 'drafts', label: 'AI 草稿', permission: 'tasks.read' },
  { key: 'approvals', label: '審批', permission: 'approvals.decide' },
  { key: 'reconciliation', label: '對帳', permission: 'documents.read' },
  { key: 'members', label: '成員', permission: 'members.read' },
  { key: 'models', label: '模型與用量', permission: 'models.manage' },
  { key: 'subscription', label: '方案', permission: 'billing.read' },
  { key: 'audit', label: '稽核紀錄', permission: 'audit.read' },
  { key: 'notifications', label: '通知', permission: null },
];

/**
 * 供 App 在 `/office` 路徑使用的 DHC AI Office（企業員工／管理端）。
 * 只呼叫 `/api/enterprise/v1`，不載入原 DHC 工作台、WebSocket、Shell 或 Agent；分頁依伺服器回傳的權限顯示，實際授權仍由後端判斷。
 */
export function OfficeApp() {
  const [identity, setIdentity] = useState<OfficeIdentity | null>(null);
  const [state, setState] = useState<'checking' | 'anonymous' | 'ready' | 'error'>(readOfficeSession() ? 'checking' : 'anonymous');
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState('documents');

  const loadIdentity = useCallback(async () => {
    setState('checking');
    try {
      setIdentity(await officeApi.identity());
      setState('ready');
    } catch (reason) {
      if ((reason as { status?: number }).status === 401) setState('anonymous');
      else { setError((reason as Error).message); setState('error'); }
    }
  }, []);

  useEffect(() => {
    if (state === 'checking') void loadIdentity();
    const onLogout = () => { setIdentity(null); setState('anonymous'); };
    window.addEventListener('dhc-office-logout', onLogout);
    return () => window.removeEventListener('dhc-office-logout', onLogout);
    // 只在掛載時檢查一次既有 session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const logout = async () => {
    try { await officeApi.logout(); } catch { /* 已失效也要清除本機 session */ }
    writeOfficeSession(null);
    setIdentity(null);
    setState('anonymous');
  };

  if (state === 'anonymous') return <OfficeLogin onLoggedIn={() => void loadIdentity()} />;
  if (state === 'checking' || !identity) {
    return <main className="p-6"><OfficeStatus loading={state === 'checking'} error={error} onRetry={() => void loadIdentity()} /></main>;
  }
  const can = (permission: string) => identity.permissions.includes(permission);
  const tabs = TABS.filter(item => item.permission === null || can(item.permission));
  const active = tabs.some(item => item.key === tab) ? tab : tabs[0]?.key;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b p-3">
        <h1 className="text-lg font-semibold">DHC AI Office</h1>
        <div className="flex items-center gap-2 text-sm">
          <span>{identity.email}</span>
          <Button size="sm" variant="outline" onClick={() => void logout()}>登出</Button>
        </div>
      </header>
      <nav className="flex flex-wrap gap-1 border-b p-2" aria-label="主要功能">
        {tabs.map(item => (
          <Button key={item.key} size="sm" variant={active === item.key ? 'default' : 'ghost'} aria-current={active === item.key ? 'page' : undefined} onClick={() => setTab(item.key)}>
            {item.label}
          </Button>
        ))}
      </nav>
      <main className="p-4">
        {active === 'documents' && <OfficeDocuments canWrite={can('documents.write')} />}
        {active === 'search' && <OfficeSearch />}
        {active === 'drafts' && <OfficeDrafts canWrite={can('tasks.write')} canRelease={identity.roles.includes('org_admin')} />}
        {active === 'approvals' && <OfficeApprovals />}
        {active === 'reconciliation' && <OfficeReconciliation canWrite={can('documents.write')} />}
        {active === 'members' && <OfficeMembers canManage={can('members.manage')} />}
        {active === 'models' && <OfficeModels canManage={can('models.manage')} />}
        {active === 'subscription' && <OfficeSubscription />}
        {active === 'audit' && <OfficeAudit />}
        {active === 'notifications' && <OfficeNotifications />}
        {!active && <p className="text-sm">您的角色目前沒有可用功能，請聯絡管理員。</p>}
      </main>
    </div>
  );
}
