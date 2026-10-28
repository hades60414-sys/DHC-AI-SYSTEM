import { useSyncExternalStore } from 'react';

import { authenticatedFetch } from '@/shared/api';

/**
 * DHC CLI settings from the server's dhc.config.json (GET /api/dhc/config). This module is the only place
 * the browser keeps them; the defaults below match the server's and apply until the first load (and in tests).
 */
export type DhcMode = 'personal' | 'team';

export type DhcConfig = {
  workspaceRoot: string;
  /** Absolute workspace root on the server (empty until loaded). */
  workspaceRootPath: string;
  /** Last folder of workspaceRoot — project paths are matched against this name. */
  workspaceRootName: string;
  mode: DhcMode;
  remote: { enabled: boolean };
  agents: string[];
  domain: string;
};

export const DEFAULT_DHC_CONFIG: DhcConfig = {
  workspaceRoot: 'DHC Workspace',
  workspaceRootPath: '',
  workspaceRootName: 'DHC Workspace',
  mode: 'personal',
  remote: { enabled: false },
  agents: ['claude', 'codex'],
  domain: 'general',
};

let current: DhcConfig = DEFAULT_DHC_CONFIG;
const listeners = new Set<() => void>();

export function getDhcConfig(): DhcConfig {
  return current;
}

export function getWorkspaceRootName(): string {
  return current.workspaceRootName;
}

/** Replaces the config (used by the loader, and by tests to switch modes). */
export function setDhcConfig(next: Partial<DhcConfig>): void {
  current = { ...current, ...next };
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useDhcConfig(): DhcConfig {
  return useSyncExternalStore(subscribe, getDhcConfig, getDhcConfig);
}

/** True in team mode: profiles, Co-Work, avatars and per-person todos are shown. */
export function useIsTeamMode(): boolean {
  return useDhcConfig().mode === 'team';
}

/** Keeps the providers listed in `agents`, in their original order; shows all if none would remain. */
export function filterEnabledAgents<T>(items: readonly T[], idOf: (item: T) => string, agents: readonly string[]): T[] {
  const kept = items.filter((item) => agents.includes(idOf(item)));
  return kept.length > 0 ? kept : [...items];
}

/** The `agents` list from dhc.config.json, re-rendering when it loads. */
export function useEnabledAgents(): string[] {
  return useDhcConfig().agents;
}

/** Fetches the server's config once; on any failure the defaults stay. */
export async function loadDhcConfig(): Promise<void> {
  try {
    const response = await authenticatedFetch('/api/dhc/config');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = (await response.json()) as Partial<DhcConfig>;
    setDhcConfig({
      ...(typeof payload.workspaceRoot === 'string' ? { workspaceRoot: payload.workspaceRoot } : {}),
      ...(typeof payload.workspaceRootPath === 'string' ? { workspaceRootPath: payload.workspaceRootPath } : {}),
      ...(typeof payload.workspaceRootName === 'string' && payload.workspaceRootName ? { workspaceRootName: payload.workspaceRootName } : {}),
      ...(payload.mode === 'personal' || payload.mode === 'team' ? { mode: payload.mode } : {}),
      ...(payload.remote && typeof payload.remote.enabled === 'boolean' ? { remote: { enabled: payload.remote.enabled } } : {}),
      ...(Array.isArray(payload.agents) && payload.agents.length > 0 ? { agents: payload.agents.filter((a) => typeof a === 'string') } : {}),
      ...(typeof payload.domain === 'string' ? { domain: payload.domain } : {}),
    });
  } catch (error) {
    console.error('[DhcConfig] Could not load /api/dhc/config; using defaults:', error);
  }
}
