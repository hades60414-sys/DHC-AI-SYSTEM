import { memo } from 'react';

import { useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { TodoDock } from '@/modules/todo-dock';
import type { ProjectWorkspaceShellProps } from '@/shared/types';

/** Rendered by ProjectWorkspaceShell to bind this module's project list to the todo-dock module. */
function ProjectTodoDock({ isMobile }: Pick<ProjectWorkspaceShellProps, 'isMobile'>) {
  const { sidebarSharedProps } = useProjectSidebarState();

  return <TodoDock projects={sidebarSharedProps.projects} isMobile={isMobile} />;
}

export default memo(ProjectTodoDock);
