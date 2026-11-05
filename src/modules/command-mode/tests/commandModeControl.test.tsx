import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, test } from 'vitest';

import CommandModeControl from '@/modules/command-mode/CommandModeControl';
import WebSocketContext from '@/shared/context/WebSocketContext';
import type { ServerEvent } from '@/shared/types';

const P = 'C:/demo/project-a';
let sent: Array<Record<string, unknown>> = [];
let listeners: Array<(event: ServerEvent) => void> = [];
let stopped = 0;

const socket = {
  ws: null,
  isConnected: true,
  sendMessage: (message: unknown) => { sent.push(message as Record<string, unknown>); },
  subscribe: (listener: (event: ServerEvent) => void) => {
    listeners.push(listener);
    return () => { listeners = listeners.filter((l) => l !== listener); };
  },
};
const Wrap = ({ children }: { children: ReactNode }) => <WebSocketContext.Provider value={socket}>{children}</WebSocketContext.Provider>;
const emit = (event: ServerEvent) => act(() => { listeners.forEach((l) => l(event)); });
const state = (phoneLive: boolean) => emit({ kind: 'command_mode_state', projectKey: P, phoneLive, sharing: false, youShare: false });

beforeEach(() => {
  sent = [];
  listeners = [];
  stopped = 0;
  const track = { stop: () => { stopped += 1; }, addEventListener: () => undefined };
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getDisplayMedia: async () => ({ getTracks: () => [track], getVideoTracks: () => [track] }) },
  });
  HTMLMediaElement.prototype.play = async () => undefined;
});

afterEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
});

test('the desktop switch appears only while a phone in this project is in a call, and hang-up turns sharing off', async () => {
  render(<CommandModeControl projectKey={P} />, { wrapper: Wrap });
  assert.deepEqual(sent[0], { type: 'command.watch', projectKey: P, profileId: null });
  assert.equal(screen.queryByTestId('command-mode-button'), null, 'no phone in a call: no button');

  await state(true);
  const button = screen.getByTestId('command-mode-button');
  assert.equal(button.textContent, '指揮模式');

  await act(async () => { fireEvent.click(button); });
  assert.ok(sent.some((m) => m.type === 'command.share' && m.active === true), 'tells the server it is sharing');
  assert.ok(screen.getByTestId('command-mode-banner').textContent?.includes('指揮模式中'), 'banner is up while sharing');

  await state(false);
  assert.equal(screen.queryByTestId('command-mode-banner'), null, 'phone hung up: banner gone');
  assert.equal(screen.queryByTestId('command-mode-button'), null);
  assert.ok(stopped > 0, 'screen capture tracks were stopped');
  assert.deepEqual(sent.at(-1), { type: 'command.share', projectKey: P, active: false, profileId: null });
});

test('state for another project does not show the switch', async () => {
  render(<CommandModeControl projectKey={P} />, { wrapper: Wrap });
  await emit({ kind: 'command_mode_state', projectKey: 'C:/demo/other', phoneLive: true, sharing: false, youShare: false });
  assert.equal(screen.queryByTestId('command-mode-button'), null);
});
