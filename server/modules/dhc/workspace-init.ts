import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProject } from '@/modules/projects/index.js';

import { loadDhcConfig, resolveWorkspaceRoot } from './dhc-config.js';

/**
 * First start: lay out the workspace root from `workspace-template/` (例行工作, 內部資料查詢\DHC CLI教學, 蒸餾任務)
 * and register the tutorial zone so the 查詢 tab is not empty. Only missing files are copied, so edits the user
 * made to their workspace are never overwritten; running it again changes nothing.
 */
export const TUTORIAL_PROJECT = path.join('內部資料查詢', 'DHC CLI教學');

function findTemplateDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  // server/modules/dhc (tsx) and dist-server/server/modules/dhc (built) both sit under the repo root.
  const candidates = [
    path.resolve(moduleDir, '..', '..', '..', 'workspace-template'),
    path.resolve(moduleDir, '..', '..', '..', '..', 'workspace-template'),
  ];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0];
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Copies files from `from` into `to` that are not there yet; returns how many were copied. */
export async function copyMissing(from: string, to: string): Promise<number> {
  let copied = 0;
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copied += await copyMissing(source, target);
    } else if (!(await exists(target))) {
      await copyFile(source, target);
      copied += 1;
    }
  }
  return copied;
}

export async function initializeWorkspace(templateDir: string = findTemplateDir()): Promise<void> {
  const root = resolveWorkspaceRoot(loadDhcConfig());
  try {
    if (!(await exists(templateDir))) {
      console.warn(`[dhc-workspace] template folder not found (${templateDir}); skipping workspace setup.`);
      return;
    }
    const copied = await copyMissing(templateDir, root);
    if (copied > 0) console.log(`[dhc-workspace] set up ${copied} file(s) in ${root}`);
    const result = await createProject({ projectPath: path.join(root, TUTORIAL_PROJECT), customName: 'DHC CLI教學' });
    if (result.outcome === 'created') console.log('[dhc-workspace] registered the DHC CLI教學 query zone');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'PROJECT_ALREADY_EXISTS') return;
    console.warn(`[dhc-workspace] workspace setup skipped: ${(error as Error).message}`);
  }
}
