import { lazy, memo, Suspense, useCallback, useEffect, useState } from 'react';

import { useProjectActiveSessionState, useProjectCommandState, useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { isQueryProject, isRoutineProject, isWorkspaceProject } from '@/modules/sidebar';
import WhoAmI from '@/modules/sidebar/WhoAmI';
import { TEAM_TOOLS, TOOL_WINDOWS, ToolLibrary, findTool, resolvePick, sharedListingId } from '@/modules/tool-library';
import { WishPool } from '@/modules/wish-pool';
import { queueAutoStart } from '@/shared/autoStartChat';
import { readDraftText, writeDraftText } from '@/shared/chatDrafts';
import { usePicks } from '@/shared/customTools';
import { startSharedToolsSync, useSharedTools } from '@/shared/sharedTools';
import { onToolHandoff } from '@/shared/toolHandoff';
import { clearBoardRequest, clearLibraryRequest, clearToolRequest, useBoardRequest, useChatMe, useLibraryRequest, useMyMentions, useToolRequest } from '@/shared/chatRoom';
import { refreshBoardInvites, useBoardInvites } from '@/shared/coBoards';
import { isFlashProject } from '@/shared/flashTasks';
import type { ProjectWorkspaceShellProps } from '@/shared/types';
import { readActiveSettingsProfile, resolveSettingsProjectId } from '@/shared/userSettings';
import { useIsTeamMode } from '@/shared/dhcConfig';

// The canvas (Excalidraw) is large, so it loads the first time a board is opened.
const PlanBoardWindow = lazy(() => import('@/modules/plan-board/PlanBoard'));
const SharedToolWindow = lazy(() => import('@/modules/tool-library/tools/SharedToolWindow'));

/**
 * Rendered by ProjectWorkspaceShell to give 自選功能 what it opens: 工具庫 (the person's five slots, kept per
 * profile), every tool window (規劃白板 and the 10/14 tools: data of this device's profile only, 開工 in that
 * profile's project), and the wish pool's discussion chat (opening message waiting in the composer, in this
 * device's own workspace project, else the open one).
 */
function ProjectWishPool({ isMobile }: Pick<ProjectWorkspaceShellProps, 'isMobile'>) {
  const isTeamMode = useIsTeamMode();
  const { sidebarSharedProps } = useProjectSidebarState();
  const { selectedProject, handleNewSession } = useProjectCommandState();
  const { activeSessionId } = useProjectActiveSessionState();
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

  // 規劃白板 10/14: the conversation open behind the board gets the brief in its composer (sent by the person).
  const onSendToChat = useCallback((brief: string) => {
    if (!activeSessionId) return;
    const existing = readDraftText(activeSessionId).trim();
    writeDraftText(activeSessionId, existing ? `${existing}\n\n${brief}` : brief);
  }, [activeSessionId]);

  const [picks, setPicks, pickError] = usePicks(profile?.id ?? null);
  // 10/22: a slot can hold a tool published from 小工具工坊 (shared:<id>); it empties itself once that tool is taken down.
  const shared = useSharedTools();
  useEffect(() => startSharedToolsSync(), []);
  const slots = picks.map((id) => resolvePick(id, shared));
  // DHC CLI 10/16: a @@whiteboard jump opens the board window on that board; mentions of you on boards badge the icons.
  const boardRequest = useBoardRequest();
  const [boardTarget, setBoardTarget] = useState<{ id: string; nonce: number } | null>(null);
  useEffect(() => {
    if (!boardRequest) return;
    setBoardTarget(boardRequest);
    setLibraryOpen(false);
    setOpenTool('plan-board');
    clearBoardRequest();
  }, [boardRequest]);
  // 10/25: 打開工具庫 from the chat's starter buttons.
  const libraryRequest = useLibraryRequest();
  useEffect(() => {
    if (!libraryRequest) return;
    setLibraryOpen(true);
    clearLibraryRequest();
  }, [libraryRequest]);
  // 10/25 R4: a 「打開：工具名」 chip under 團隊小助理's answer opens that tool.
  const toolRequest = useToolRequest();
  useEffect(() => {
    if (!toolRequest) return;
    setLibraryOpen(false);
    setOpenTool(toolRequest);
    clearToolRequest();
  }, [toolRequest]);
  const mentions = useMyMentions();
  const boardInvites = useBoardInvites(useChatMe());
  // Leaving the board window re-reads the invitations, so one just opened stops showing.
  useEffect(() => {
    if (openTool !== 'plan-board') refreshBoardInvites();
  }, [openTool]);
  let boardMentions = 0;
  for (const [key, count] of mentions) if (key.startsWith('b:')) boardMentions += count;
  boardMentions += boardInvites.length;
  const badges = boardMentions > 0 ? { 'plan-board': boardMentions } : undefined;
  const openToolWindow = (id: string) => {
    setLibraryOpen(false);
    setOpenTool(id);
  };
  const sharedOpen = sharedListingId(openTool);
  const ToolWindow = openTool && openTool !== 'plan-board' ? TOOL_WINDOWS[openTool] ?? null : null;
  const toolName = findTool(openTool)?.name ?? '這個工具';

  return (
    <>
      <WishPool
        isMobile={isMobile}
        onDiscuss={onDiscuss}
        slots={slots}
        onOpenTool={openToolWindow}
        badges={badges}
        onOpenLibrary={() => setLibraryOpen(true)}
        wishesOpen={wishesOpen}
        onWishesOpenChange={setWishesOpen}
      />
      {libraryOpen && (
        <ToolLibrary
          isMobile={isMobile}
          picks={picks}
          onPicksChange={setPicks}
          pickError={pickError}
          badges={badges}
          onOpenTool={openToolWindow}
          onOpenWishes={() => { setLibraryOpen(false); setWishesOpen(true); }}
          onClose={() => setLibraryOpen(false)}
        />
      )}
      {sharedOpen && (
        <Suspense fallback={<div className="fixed inset-0 z-[60] flex items-center justify-center bg-background text-sm text-muted-foreground">載入中…</div>}>
          <SharedToolWindow listingId={sharedOpen} isMobile={isMobile} onClose={() => setOpenTool(null)} />
        </Suspense>
      )}
      {openTool && openTool !== 'plan-board' && !sharedOpen && !profile && !TEAM_TOOLS.has(openTool) && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/60 backdrop-blur-sm" role="dialog" aria-label={toolName}>
          <div className="flex max-h-[90vh] w-full max-w-sm flex-col rounded-lg border border-border bg-background p-4 text-sm shadow-xl">
            {/* 10/25: choose who you are right here (the page reloads; open the tool again). */}
            {isTeamMode && <WhoAmI inline note={`${toolName}的內容只存在你自己名下，別人看不到。先選你是誰，畫面重新整理後再打開一次。`} className="mb-3" />}
            <button type="button" onClick={() => setOpenTool(null)} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
              先不要
            </button>
          </div>
        </div>
      )}
      {ToolWindow && (profile || TEAM_TOOLS.has(openTool!)) && (
        <Suspense fallback={<div className="fixed inset-0 z-[60] flex items-center justify-center bg-background text-sm text-muted-foreground">{toolName}載入中…</div>}>
          <ToolWindow
            profileId={profile?.id ?? ''}
            profileName={profile?.name ?? '全組'}
            projectId={profileProject?.projectId ?? null}
            isMobile={isMobile}
            projects={projects}
            onClose={() => setOpenTool(null)}
            onStartWork={profileProject ? (brief) => { onStartWork(brief); setOpenTool(null); } : null}
          />
        </Suspense>
      )}
      {boardOpen && !profile && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background/60 backdrop-blur-sm" role="dialog" aria-label="規劃白板">
          <div className="flex max-h-[90vh] w-full max-w-sm flex-col rounded-lg border border-border bg-background p-4 text-sm shadow-xl">
            {isTeamMode && <WhoAmI inline note="規劃白板只存在你自己名下，別人看不到。先選你是誰，畫面重新整理後再打開一次白板。" className="mb-3" />}
            <button type="button" onClick={() => setBoardOpen(false)} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
              先不要
            </button>
          </div>
        </div>
      )}
      {boardOpen && profile && (
        <Suspense fallback={<div className="fixed inset-0 z-[60] flex items-center justify-center bg-background text-sm text-muted-foreground">白板載入中…</div>}>
          <PlanBoardWindow
            key={boardTarget?.nonce ?? 'board'}
            initialBoardId={boardTarget?.id ?? null}
            profileId={profile.id}
            profileName={profile.name}
            legacyProjectId={profileProjectId}
            isMobile={isMobile}
            onClose={() => { setBoardOpen(false); setBoardTarget(null); }}
            onStartWork={profileProject ? onStartWork : null}
            sessionId={activeSessionId}
            onSendToChat={activeSessionId ? onSendToChat : null}
          />
        </Suspense>
      )}
    </>
  );
}

export default memo(ProjectWishPool);
