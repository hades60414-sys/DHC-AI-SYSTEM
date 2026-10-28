import { describe, expect, it } from 'vitest';

import { isWorkspaceProject } from '@/modules/sidebar/hooks/useSidebarController';

describe('isWorkspaceProject', () => {
  it('shows folders directly under the workspace root', () => {
    expect(isWorkspaceProject({ fullPath: 'C:\\Users\\demo\\DHC Workspace\\同事A' })).toBe(true);
    expect(isWorkspaceProject({ fullPath: 'C:\\Users\\demo\\DHC Workspace\\工具實驗\\' })).toBe(true);
  });

  it('hides Codex scratch folders and nested work dirs', () => {
    expect(isWorkspaceProject({ fullPath: 'C:\\Users\\demo\\Documents\\Codex\\2026-01-01\\new-chat' })).toBe(false);
    expect(isWorkspaceProject({ fullPath: 'C:\\Users\\demo\\DHC Workspace\\工具實驗\\.cache\\run-01\\work' })).toBe(false);
    expect(isWorkspaceProject({ fullPath: 'C:\\Users\\demo\\DHC Workspace' })).toBe(false);
    expect(isWorkspaceProject({ fullPath: '' })).toBe(false);
  });
});
