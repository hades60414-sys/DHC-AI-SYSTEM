import { lazy, memo, Suspense, useCallback, useEffect, useState } from 'react';

import { useProjectCommandState, useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { isQueryProject, isRoutineProject, isWorkspaceProject } from '@/modules/sidebar';
import { TOOL_WINDOWS, ToolLibrary, findTool, isToolReady } from '@/modules/tool-library';
import { WishPool } from '@/modules/wish-pool';
import { queueAutoStart } from '@/shared/autoStartChat';
import { readDraftText, writeDraftText } from '@/shared/chatDrafts';
import { usePicks } from '@/shared/customTools';
import { onToolHandoff } from '@/shared/toolHandoff';
import { isFlashProject } from '@/shared/flashTasks';
import type { ProjectWorkspaceShellProps } from '@/shared/types';
import { readActiveSettingsProfile, resolveSettingsProjectId } from '@/shared/userSettings';

// The canvas (Excalidraw) is large, so it loads the first time a board is opened.
// Straight to the file, not the barrel: the lazy chunk keeps Excalidraw out of the main bundle.
// oxlint-disable-next-line boundaries/dependencies
const PlanBoardWindow = lazy(() => import('@/modules/plan-board/PlanBoard'));

/**
 * Rendered by ProjectWorkspaceShell to give 自選功能 what it opens: 工具庫 (the person's five slots, kept per
 * profile), every tool window (規劃白板 and the 10/14 tools: data of this device's profile only, 開工 in that
 * profile's project), and the wish pool's discussion chat (opening message waiting in the composer, in this
 * device's own workspace project, else the open one).
 */
function ProjectWishPool({ isMobile }: Pick<ProjectWorkspaceShellProps, 'isMobile'>) {
  const { sidebarSharedProps } = useProjectSidebarState();
  const { selectedProject, handleNewSession } = useProjectCommandState();
  const { projects } = sidebarSharedProps;
  const [openTool, setOpenTool] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [wishesOpen, setWishesOpen] = useState(false);
  const boardOpen = openTool === 'plan-board';
  // One tool handing something to another: close the sender, open the receiver (it takes the handoff itself).
  useEffect(() => onToolHandoff((handoff) => {
    setLibraryOpen(false);
    setOpenTool(null);
    window.setTimeout(() => setOpenTool(handoff.tool), 0);
  }), []);
  const setBoardOpen = (open: boolean) => setOpenTool(open ? 'plan-board' : null);

  const ownProject = useCallback(() => {
    const people = projects.filter((project) => (
      isWorkspaceProject(project) && !isQueryProject(project) && !isRoutineProject(project) && !isFlashProject(project)
    ));
    const ownId = resolveSettingsProjectId(people);
    return people.find((item) => item.projectId === ownId) ?? selectedProject ?? people[0] ?? null;
  }, [projects, selectedProject]);

  const onDiscuss = useCallback((prompt: string) => {
    const project = ownProject();
    if (!project) return;
    const scope = `project:${project.projectId}`;
    const existing = readDraftText(scope).trim();
    // Text already waiting in that composer stays, below the opening message.
    writeDraftText(scope, existing ? `${prompt}\n\n${existing}` : prompt);
    handleNewSession(project);
  }, [handleNewSession, ownProject]);

  // Boards belong to this device's profile (the person), never to whichever project happens to be open.
  const profile = readActiveSettingsProfile();
  const people = projects.filter((project) => isWorkspaceProject(project));
  const profileProjectId = profile ? resolveSettingsProjectId(people) : null;
  const profileProject = people.find((item) => item.projectId === profileProjectId) ?? null;
  const onStartWork = useCallback((brief: string) => {
    if (!profileProject) return;
    queueAutoStart(profileProject.projectId, brief);
    handleNewSession(profileProject);
  }, [handleNewSession, profileProject]);

  const [picks, setPicks] = usePicks(profile?.id ?? null);
  const slots = picks.map((id) => {
    const tool = findTool(id);
    return tool && isToolReady(tool.id) ? { id: tool.id, name: tool.name, icon: tool.icon } : null;
  });
  const openToolWindow = (id: string) => {
    setLibraryOpen(false);
    setOpenTool(id);
  };
  const ToolWindow = openTool && openTool !== 'plan-board' ? TOOL_WINDOWS[openTool] ?? null : null;
  const toolName = findTool(openTool)?.name ?? '這個工具';

  return (
    <>
      <WishPool
        isMobile={isMobile}
        onDiscuss={onDiscuss}
        slots={slots}
        onOpenTool={openToolWindow}
        onOpenLibrary={() => setLibraryOpen(true)}
        wishesOpen={wishesOpen}
        onWishesOpenChange={setWishesOpen}
      />
      {libraryOpen && (
        <ToolLibrary
          isMobile={isMobile}
          picks={picks}
          onPicksChange={setPicks}
          onOpenTool={openToolWindow}
          onOpenWishes={() => { setLibraryOpen(false); setWishesOpen(true); }}
          onClose={() => setLibraryOpen(false)}
        />
      )}
      {openTool && openTool !== 'plan-board' && !profile && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/60 backdrop-blur-sm" role="dialog" aria-label={toolName}>
          <div className="max-w-sm rounded-lg border border-border bg-background p-4 text-sm shadow-xl">
            <p className="mb-3 leading-relaxed text-foreground">
              {toolName}跟著帳號（這台裝置的專案設定）走，別人看不到。這台裝置還沒選專案設定，先到左下「設定 → 專案設定」選你自己，再打開。
            </p>
            <button type="button" onClick={() => setOpenTool(null)} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
              知道了
            </button>
          </div>
        </div>
      )}
      {ToolWindow && profile && (
        <Suspense fallback={<div className="fixed inset-0 z-[60] flex items-center justify-center bg-background text-sm text-muted-foreground">{toolName}載入中…</div>}>
          <ToolWindow
            profileId={profile.id}
            profileName={profile.name}
            projectId={profileProject?.projectId ?? null}
            isMobile={isMobile}
            onClose={() => setOpenTool(null)}
            onStartWork={profileProject ? (brief) => { onStartWork(brief); setOpenTool(null); } : null}
          />
        </Suspense>
      )}
      {boardOpen && !profile && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/60 backdrop-blur-sm" role="dialog" aria-label="規劃白板">
          <div className="max-w-sm rounded-lg border border-border bg-background p-4 text-sm shadow-xl">
            <p className="mb-3 leading-relaxed text-foreground">
              規劃白板跟著帳號（這台裝置的專案設定）走，別人看不到。這台裝置還沒選專案設定，先到左下「設定 → 專案設定」選你自己，再打開白板。
            </p>
            <button type="button" onClick={() => setBoardOpen(false)} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
              知道了
            </button>
          </div>
        </div>
      )}
      {boardOpen && profile && (
        <Suspense fallback={<div className="fixed inset-0 z-[60] flex items-center justify-center bg-background text-sm text-muted-foreground">白板載入中…</div>}>
          <PlanBoardWindow
            profileId={profile.id}
            profileName={profile.name}
            legacyProjectId={profileProjectId}
            isMobile={isMobile}
            onClose={() => setBoardOpen(false)}
            onStartWork={profileProject ? onStartWork : null}
          />
        </Suspense>
      )}
    </>
  );
}

export default memo(ProjectWishPool);
