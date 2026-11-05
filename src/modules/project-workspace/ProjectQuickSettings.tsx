import { memo } from 'react';

import { useProjectCommandState } from '@/modules/project-workspace/context/ProjectsStateContext';
import { QuickSettingsPanel } from '@/modules/quick-settings-panel';

/** Rendered by ProjectWorkspaceShell on phones to give the quick drawer a way into the full settings window. */
function ProjectQuickSettings() {
  const { openSettings } = useProjectCommandState();
  return <QuickSettingsPanel onOpenAllSettings={() => openSettings()} />;
}

export default memo(ProjectQuickSettings);
