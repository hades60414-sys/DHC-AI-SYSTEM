import { memo } from 'react';

import { useProjectSidebarState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { ChatRoom } from '@/modules/chat-room';
import type { ProjectWorkspaceShellProps } from '@/shared/types';

/** Rendered by ProjectWorkspaceShell to bind this module's project list to the chat-room module. */
function ProjectChatRoom({ isMobile }: Pick<ProjectWorkspaceShellProps, 'isMobile'>) {
  const { sidebarSharedProps } = useProjectSidebarState();

  return <ChatRoom projects={sidebarSharedProps.projects} isMobile={isMobile} />;
}

export default memo(ProjectChatRoom);
