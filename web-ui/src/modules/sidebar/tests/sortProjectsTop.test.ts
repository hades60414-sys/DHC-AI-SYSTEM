import assert from 'node:assert/strict';

import { test } from 'vitest';

import { sortProjects } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import type { Project } from '@/shared/types';

const project = (projectId: string, displayName: string, isStarred = false) =>
  ({ projectId, displayName, isStarred, sessions: [] }) as unknown as Project;

test('the settings-profile project sits first; an old project star no longer reorders', () => {
  const list = [project('b', 'Beta'), project('c', 'Gamma', true), project('a', 'Alpha')];
  assert.deepEqual(sortProjects(list, 'name', 'b').map((p) => p.projectId), ['b', 'a', 'c']);
  assert.deepEqual(sortProjects(list, 'name').map((p) => p.projectId), ['a', 'b', 'c']);
});
