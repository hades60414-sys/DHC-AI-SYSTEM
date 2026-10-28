#!/usr/bin/env node
// Copies Excalidraw's fonts from node_modules into public/excalidraw/fonts so the whiteboard loads them
// from this site instead of a public CDN (see src/modules/plan-board/excalidrawAssets.ts). Runs before the
// client build and dev server; the copy is git-ignored.
import fs from 'node:fs';
import path from 'node:path';

const source = path.join('node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod', 'fonts');
const target = path.join('public', 'excalidraw', 'fonts');

if (!fs.existsSync(source)) {
  console.warn(`copy-excalidraw-fonts: ${source} not found; the whiteboard will fall back to the CDN fonts.`);
  process.exit(0);
}
fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
