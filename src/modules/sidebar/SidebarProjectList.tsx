import { useEffect, useMemo } from 'react';

import type { SidebarProjectListProps } from '@/shared/types';
import { getPageTitle } from '@/shared/utils';
import { useIsPresenter } from '@/shared/context/ThemeContext';
import SidebarProjectItem from '@/modules/sidebar/SidebarProjectItem';
import SidebarProjectsState from '@/modules/sidebar/SidebarProjectsState';
import { getAllSessions, getSessionDate } from '@/modules/sidebar/utils/sidebarProjectFormatting';


/** Rendered by SidebarContent to list the filtered projects, delegating each row to SidebarProjectItem. */
export default function SidebarProjectList({
  projects,
  filteredProjects,
  selectedProject,
  selectedSession,
  isLoading,
  loadingProgress,
  expandedProjects,
  activeRename,
  initialSessionsLoaded,
  currentTime,

  deletingProjects,
  tasksEnabled,
  mcpServerStatus,
  getProjectSessions,
  onLoadMoreSessions,
  loadingMoreProjects,
  activeSessions,
  attentionSessionIds,
  forceExpanded = false,
  runningOnly = false,
  isProjectStarred,
  onRenameDraftChange,
  onToggleProject,
  onProjectSelect,
  onToggleStarProject,
  onStartEditingProject,
  onCancelEditingProject,
  onSaveProjectName,
  onDeleteProject,
  onSessionSelect,
  onDeleteSession,
  onForkSession,
  onNewSession,
  onStartEditingSession,
  onCancelEditingSession,
  onSaveEditingSession,
  t,
}: SidebarProjectListProps) {
  const isPresenter = useIsPresenter();
  // 投影 外觀：分頁標題固定，不露出對話名稱
  const pageTitle = isPresenter ? 'DHC CLI' : getPageTitle(selectedProject, selectedSession);
  const state = (
    <SidebarProjectsState
      isLoading={isLoading}
      loadingProgress={loadingProgress}
      projectsCount={projects.length}
      filteredProjectsCount={filteredProjects.length}
      t={t}
    />
  );

  // DHC CLI: sessions finished or waiting on you (and not looked at yet) show as "(N)" in the tab title,
  // so the taskbar tells you something needs you even when the tab is buried.
  const attentionCount = attentionSessionIds.size;
  useEffect(() => {
    document.title = attentionCount > 0 ? `(${attentionCount}) ${pageTitle}` : pageTitle;
  }, [pageTitle, attentionCount]);

  // DHC CLI Co-Work: a shared row sits in another project's list but should sink or rise with the owner's activity.
  // Keyed on the activity itself so a rename (a new projects array) does not hand every row a new map.
  const activityKey = projects
    .flatMap((project) => getAllSessions(project).map((session) => `${session.id}:${getSessionDate(session).getTime()}`))
    .join(',');
  const sessionActivity = useMemo(() => new Map<string, number>(activityKey ? activityKey.split(',').map((entry) => {
    const at = entry.lastIndexOf(':');
    return [entry.slice(0, at), Number(entry.slice(at + 1))];
  }) : []), [activityKey]);

  const showProjects = !isLoading && projects.length > 0 && filteredProjects.length > 0;

  return (
      <div className="pb-safe-area-inset-bottom md:space-y-1">
        {!showProjects
          ? state
          : filteredProjects.map((project) => {
              // Both renames are resolved here rather than inside the row, so
              // every other row is handed the same scalars on each keystroke and
              // its memo boundary holds.
              const renamingProject =
                activeRename?.target === 'project' && activeRename.id === project.projectId
                  ? activeRename
                  : null;
              const renamingSession =
                activeRename?.target === 'session' && activeRename.projectId === project.projectId
                  ? activeRename
                  : null;

              // React key + per-project state lookups all use the DB `projectId`
              // so they remain stable across renames and session changes.
              return (
              <SidebarProjectItem
                key={project.projectId}
                project={project}
                selectedProject={selectedProject}
                selectedSession={selectedSession}
                isExpanded={forceExpanded || expandedProjects.has(project.projectId)}
                isDeleting={deletingProjects.has(project.projectId)}
                isStarred={isProjectStarred(project.projectId)}
                isEditing={renamingProject !== null}
                renameDraft={renamingProject?.draft ?? ''}
                sessions={getProjectSessions(project)}
                sessionActivity={sessionActivity}
                initialSessionsLoaded={initialSessionsLoaded.has(project.projectId)}
                isLoadingMoreSessions={loadingMoreProjects.has(project.projectId)}
                currentTime={currentTime}
                sessionRenameId={renamingSession?.id ?? null}
                sessionRenameDraft={renamingSession?.draft ?? ''}
                tasksEnabled={tasksEnabled}
                mcpServerStatus={mcpServerStatus}
                onRenameDraftChange={onRenameDraftChange}
                onToggleProject={onToggleProject}
                onProjectSelect={onProjectSelect}
                onToggleStarProject={onToggleStarProject}
                onStartEditingProject={onStartEditingProject}
                onCancelEditingProject={onCancelEditingProject}
                onSaveProjectName={onSaveProjectName}
                onDeleteProject={onDeleteProject}
                onSessionSelect={onSessionSelect}
                onDeleteSession={onDeleteSession}
                onForkSession={onForkSession}
                onLoadMoreSessions={onLoadMoreSessions}
                activeSessions={activeSessions}
                attentionSessionIds={attentionSessionIds}
                runningOnly={runningOnly}
                onNewSession={onNewSession}
                onStartEditingSession={onStartEditingSession}
                onCancelEditingSession={onCancelEditingSession}
                onSaveEditingSession={onSaveEditingSession}
                t={t}
              />
            );
          })}
    </div>
  );
}
