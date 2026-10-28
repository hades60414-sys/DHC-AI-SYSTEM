import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * DHC CLI settings from `dhc.config.json` at the repo root (or the file named by DHC_CONFIG).
 * Read once at startup; a missing file or a bad value falls back to the default with a warning,
 * so the server always starts.
 */
export type DhcMode = 'personal' | 'team';

export type DhcConfig = {
  /** Folder that holds one sub-folder per project. Relative paths resolve against the home directory. */
  workspaceRoot: string;
  mode: DhcMode;
  remote: { enabled: boolean };
  /** Provider ids shown in the UI, e.g. claude, codex, cursor, opencode. */
  agents: string[];
  domain: string;
};

/** What the browser gets: the config plus the resolved root and the folder name the sidebar matches project paths against. */
export type DhcPublicConfig = DhcConfig & { workspaceRootPath: string; workspaceRootName: string };

export const DEFAULT_DHC_CONFIG: DhcConfig = {
  workspaceRoot: 'DHC Workspace',
  mode: 'personal',
  remote: { enabled: false },
  agents: ['claude', 'codex'],
  domain: 'general',
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Validates parsed JSON field by field; anything unusable keeps its default. */
export function parseDhcConfig(raw: unknown, warn: (message: string) => void = () => {}): DhcConfig {
  const config: DhcConfig = { ...DEFAULT_DHC_CONFIG, remote: { ...DEFAULT_DHC_CONFIG.remote }, agents: [...DEFAULT_DHC_CONFIG.agents] };
  if (!isPlainObject(raw)) {
    if (raw !== undefined) warn('dhc.config.json is not a JSON object; using defaults.');
    return config;
  }

  if (raw.workspaceRoot !== undefined) {
    if (typeof raw.workspaceRoot === 'string' && raw.workspaceRoot.trim()) config.workspaceRoot = raw.workspaceRoot.trim();
    else warn('workspaceRoot must be a non-empty string; using the default.');
  }
  if (raw.mode !== undefined) {
    if (raw.mode === 'personal' || raw.mode === 'team') config.mode = raw.mode;
    else warn('mode must be "personal" or "team"; using "personal".');
  }
  if (raw.remote !== undefined) {
    if (isPlainObject(raw.remote) && typeof raw.remote.enabled === 'boolean') config.remote = { enabled: raw.remote.enabled };
    else warn('remote must look like { "enabled": false }; remote stays off.');
  }
  if (raw.agents !== undefined) {
    const agents = Array.isArray(raw.agents)
      ? [...new Set(raw.agents.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map((a) => a.trim().toLowerCase()))]
      : [];
    if (agents.length > 0) config.agents = agents;
    else warn('agents must be a non-empty list such as ["claude", "codex"]; using the default.');
  }
  if (raw.domain !== undefined) {
    if (typeof raw.domain === 'string' && /^[a-z0-9-]+$/.test(raw.domain)) config.domain = raw.domain;
    else warn('domain must be a lowercase name such as "general" or "finance"; using "general".');
  }
  return config;
}

/** Absolute path of the workspace root. */
export function resolveWorkspaceRoot(config: DhcConfig): string {
  return path.resolve(os.homedir(), config.workspaceRoot);
}

function findConfigFile(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.DHC_CONFIG,
    path.join(process.cwd(), 'dhc.config.json'),
    // server/modules/dhc (tsx) and dist-server/server/modules/dhc (built) both sit under the repo root.
    path.resolve(moduleDir, '..', '..', '..', 'dhc.config.json'),
    path.resolve(moduleDir, '..', '..', '..', '..', 'dhc.config.json'),
  ];
  return candidates.find((file): file is string => Boolean(file) && existsSync(file as string)) ?? null;
}

let cached: DhcConfig | null = null;

export function loadDhcConfig(): DhcConfig {
  if (cached) return cached;
  const warn = (message: string) => console.warn(`[dhc-config] ${message}`);
  const file = findConfigFile();
  if (!file) {
    cached = parseDhcConfig(undefined, warn);
    return cached;
  }
  try {
    cached = parseDhcConfig(JSON.parse(readFileSync(file, 'utf8')), warn);
  } catch (error) {
    warn(`could not read ${file} (${(error as Error).message}); using defaults.`);
    cached = parseDhcConfig(undefined, warn);
  }
  return cached;
}

export function getDhcPublicConfig(): DhcPublicConfig {
  const config = loadDhcConfig();
  const workspaceRootPath = resolveWorkspaceRoot(config);
  return { ...config, workspaceRootPath, workspaceRootName: path.basename(workspaceRootPath) };
}
