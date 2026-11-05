import { Bot, FolderOpen, LayoutGrid } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import MobileMenuButton from '@/modules/project-workspace/MobileMenuButton';
import MobileRailToggle from '@/modules/project-workspace/MobileRailToggle';
import { ASSISTANT_ID, dmRoom, openChatPanel, requestOpenLibrary, useChatMe } from '@/shared/chatRoom';

type WorkspaceStateViewProps = {
  mode: 'loading' | 'empty';
  isMobile: boolean;
  onMenuClick: () => void;
};

/** Rendered by WorkspaceMain instead of the workspace while projects load or when none is selected. */
export default function WorkspaceStateView({ mode, isMobile, onMenuClick }: WorkspaceStateViewProps) {
  const { t } = useTranslation();

  const isLoading = mode === 'loading';
  const me = useChatMe();
  // 10/25 R4 (稽核 P1-5): three ways in instead of the upstream 「選擇您的專案」 tip.
  const starts = [
    { id: 'assistant', icon: Bot, title: '問團隊小助理', note: '查資料庫、看排程、整理數字，打字問就好', onPick: () => openChatPanel(me ? dmRoom(me, ASSISTANT_ID) : null) },
    { id: 'library', icon: LayoutGrid, title: '打開工具庫', note: '試算工作台、專案板、文件共編等小工具', onPick: () => requestOpenLibrary() },
    { id: 'project', icon: FolderOpen, title: '選專案開對話', note: isMobile ? '打開左上的專案列表，選你的專案' : '在左邊選你的專案，開一個新對話', onPick: onMenuClick },
  ];

  return (
    <div className="flex h-full flex-col">
      {isMobile && (
        <div className="pwa-header-safe flex flex-shrink-0 items-center border-b border-border/50 bg-background/80 p-2 backdrop-blur-sm sm:p-3">
          <MobileMenuButton onMenuClick={onMenuClick} compact />
          <MobileRailToggle />
        </div>
      )}

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center text-muted-foreground">
            <div className="mx-auto mb-4 h-10 w-10">
              <div
                className="h-full w-full rounded-full border-[3px] border-muted border-t-primary"
                style={{
                  animation: 'spin 1s linear infinite',
                  WebkitAnimation: 'spin 1s linear infinite',
                  MozAnimation: 'spin 1s linear infinite',
                }}
              />
            </div>
            <h2 className="mb-1 text-lg font-semibold text-foreground">{t('mainContent.loading')}</h2>
            <p className="text-sm">{t('mainContent.settingUpWorkspace')}</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="mx-auto max-w-md px-6 text-center">
            <h2 className="mb-2 text-xl font-semibold text-foreground">{t('mainContent.chooseProject')}</h2>
            <p className="mb-5 text-sm leading-relaxed text-muted-foreground">{t('mainContent.selectProjectDescription')}</p>
            <div className="grid gap-2.5 text-left" data-testid="start-cards">
              {starts.map(({ id, icon: Icon, title, note, onPick }) => (
                <button key={id} type="button" data-start={id} onClick={onPick} className="flex items-center gap-3 rounded-xl text-left border border-border bg-card px-3.5 py-3 shadow-sm transition hover:border-primary/40 hover:bg-primary/5">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Icon className="h-4 w-4" /></span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">{title}</span>
                    <span className="block text-xs text-muted-foreground">{note}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
