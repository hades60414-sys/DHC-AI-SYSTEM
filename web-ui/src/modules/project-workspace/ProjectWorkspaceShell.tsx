import { memo } from 'react';

import ProjectEffects from '@/modules/project-workspace/controllers/ProjectEffects';
import type { ProjectWorkspaceShellProps } from '@/shared/types';
import { useIsPresenter } from '@/shared/context/ThemeContext';
import ProjectCommandPalette from '@/modules/project-workspace/ProjectCommandPalette';
import ProjectMainRegion from '@/modules/project-workspace/ProjectMainRegion';
import ProjectSidebarRegion from '@/modules/project-workspace/ProjectSidebarRegion';
import ProjectChatRoom from '@/modules/project-workspace/ProjectChatRoom';
import ProjectTodoDock from '@/modules/project-workspace/ProjectTodoDock';
import ProjectQuickSettings from '@/modules/project-workspace/ProjectQuickSettings';
import ProjectWishPool from '@/modules/project-workspace/ProjectWishPool';

/** Rendered by ProjectWorkspaceRoute to lay out the workspace sidebar, main region and global overlays. */
function ProjectWorkspaceShell({
  isMobile,
  ws,
  sendMessage,
  navigate,
}: ProjectWorkspaceShellProps) {
  const isPresenter = useIsPresenter();
  return (
    <div
      className="fixed inset-0 flex bg-background"
      style={{ bottom: 'var(--keyboard-height, 0px)' }}
    >
      <ProjectEffects navigate={navigate} />
      <ProjectSidebarRegion isMobile={isMobile} />

      <div data-presenter-main className="relative flex min-w-0 flex-1 flex-col">
        {isPresenter && (
          <div className="mx-3 mt-2 flex-shrink-0 rounded bg-muted px-3 py-1.5 text-xs text-foreground/80">
            Gemini模型新上線，歡迎大家多多使用，相關網路搜尋功能持續升級中！
          </div>
        )}
        <ProjectMainRegion
          isMobile={isMobile}
          ws={ws}
          sendMessage={sendMessage}
          navigate={navigate}
        />
      </div>

      {/* 投影 外觀：DHC 自己加的把手平常藏起來，按住 Alt 才浮出（index.css .presenter） */}
      <div data-presenter-extra="dock" className="contents">
        <ProjectTodoDock isMobile={isMobile} />
        <ProjectWishPool isMobile={isMobile} />
        <ProjectChatRoom isMobile={isMobile} />
      </div>
      {isPresenter && <div aria-hidden className="presenter-watermark" />}
      {/* 手機：右緣把手已收掉，快速設定面板只由頂端漢堡的「設定」叫出（見 MobileRailToggle） */}
      {isMobile && <ProjectQuickSettings />}
      <ProjectCommandPalette />
    </div>
  );
}

export default memo(ProjectWorkspaceShell);
