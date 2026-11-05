// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const agyWorkspaceAccess = vi.fn();
vi.mock('@/shared/api', () => ({ api: { agyWorkspaceAccess: (path: string) => agyWorkspaceAccess(path) } }));

import { parseAgyWorkspaceAccess, useAgyWorkspaceAccess } from '@/modules/chat/hooks/useAgyWorkspaceAccess';

const jsonResponse = (body: unknown, ok = true) => ({ ok, json: async () => body }) as unknown as Response;

describe('parseAgyWorkspaceAccess', () => {
  it('allows only an explicit allowed:true', () => {
    expect(parseAgyWorkspaceAccess({ data: { allowed: true, reason: null } })).toEqual({ allowed: true, reason: null, loading: false });
    expect(parseAgyWorkspaceAccess({ data: { allowed: 'true' } }).allowed).toBe(false);
    expect(parseAgyWorkspaceAccess(null).allowed).toBe(false);
    expect(parseAgyWorkspaceAccess({}).reason).toMatch(/白名單/);
  });

  it('keeps the server reason when the project is refused', () => {
    expect(parseAgyWorkspaceAccess({ data: { allowed: false, reason: '不在白名單' } })).toEqual({
      allowed: false,
      reason: '不在白名單',
      loading: false,
    });
  });
});

describe('useAgyWorkspaceAccess', () => {
  beforeEach(() => agyWorkspaceAccess.mockReset());

  it('starts closed, then follows the server answer', async () => {
    agyWorkspaceAccess.mockResolvedValue(jsonResponse({ data: { allowed: true, reason: null } }));
    const { result } = renderHook(() => useAgyWorkspaceAccess('C:\\Users\\demo\\DHC Workspace\\工具實驗'));
    expect(result.current).toMatchObject({ allowed: false, loading: true });
    await waitFor(() => expect(result.current.allowed).toBe(true));
    expect(agyWorkspaceAccess).toHaveBeenCalledWith('C:\\Users\\demo\\DHC Workspace\\工具實驗');
  });

  it('stays closed with the reason for a refused project and on request failure', async () => {
    agyWorkspaceAccess.mockResolvedValueOnce(jsonResponse({ data: { allowed: false, reason: '不在白名單' } }));
    const refused = renderHook(() => useAgyWorkspaceAccess('D:\\x'));
    await waitFor(() => expect(refused.result.current.loading).toBe(false));
    expect(refused.result.current).toMatchObject({ allowed: false, reason: '不在白名單' });

    agyWorkspaceAccess.mockRejectedValueOnce(new Error('offline'));
    const failed = renderHook(() => useAgyWorkspaceAccess('D:\\y'));
    await waitFor(() => expect(failed.result.current.loading).toBe(false));
    expect(failed.result.current.allowed).toBe(false);
  });

  it('is closed without a project path and never calls the server', async () => {
    const { result } = renderHook(() => useAgyWorkspaceAccess(undefined));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.allowed).toBe(false);
    expect(agyWorkspaceAccess).not.toHaveBeenCalled();
  });
});
