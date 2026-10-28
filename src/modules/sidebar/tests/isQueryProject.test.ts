import { describe, expect, it } from 'vitest';

import { isQueryProject } from '@/modules/sidebar/hooks/useSidebarController';

/** DHC CLI 查詢分頁: 內部資料查詢 and its direct sub-folders (zones) belong to the 查詢 tab. */
describe('isQueryProject', () => {
  it('matches the 內部資料查詢 workspace and its zone sub-folders only', () => {
    expect(isQueryProject({ fullPath: 'C:\\Users\\demo\\DHC Workspace\\內部資料查詢' })).toBe(true);
    expect(isQueryProject({ fullPath: 'C:\\Users\\demo\\DHC Workspace\\內部資料查詢\\DHC CLI教學' })).toBe(true);
    expect(isQueryProject({ fullPath: 'C:\\Users\\demo\\DHC Workspace\\內部資料查詢\\DHC CLI教學\\深層' })).toBe(false);
    expect(isQueryProject({ fullPath: 'C:\\Users\\demo\\DHC Workspace\\工具實驗' })).toBe(false);
    expect(isQueryProject({ fullPath: 'C:\\Users\\demo\\DHC Workspace\\工具實驗\\內部資料查詢' })).toBe(false);
  });
});
