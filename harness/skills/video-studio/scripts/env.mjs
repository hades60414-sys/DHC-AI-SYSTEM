import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
export const SKILL = path.dirname(SCRIPTS);
export const HOME = process.env.VIDEO_STUDIO_HOME ?? path.join(os.homedir(), 'video-studio');
