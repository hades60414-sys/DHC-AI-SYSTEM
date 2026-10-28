import { describe, expect, it } from 'vitest';

import { isRoutineProject } from '@/modules/sidebar/hooks/useSidebarController';

/** DHC CLI 例行分頁: each direct sub-folder of 例行工作 is one routine; the root folder itself is not. */
describe('isRoutineProject', () => {
  it('matches only first-level folders under the workspace 例行工作 folder', () => {
    expect(isRoutineProject({ fullPath: 'C:\\Users\\demo\\DHC Workspace\\例行工作\\月報' })).toBe(true);
    expect(isRoutineProject({ fullPath: 'C:\\Users\\demo\\DHC Workspace\\例行工作' })).toBe(false);
    expect(isRoutineProject({ fullPath: 'C:\\Users\\demo\\DHC Workspace\\例行工作\\月報\\產出' })).toBe(false);
    expect(isRoutineProject({ fullPath: 'C:\\Users\\demo\\DHC Workspace\\工具實驗\\例行工作\\月報' })).toBe(false);
  });
});
