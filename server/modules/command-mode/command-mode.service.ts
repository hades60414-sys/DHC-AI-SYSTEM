import type { WebSocket } from 'ws';

import { CommandModeHub, parseFrame, type CommandModeOutbound, type HubSocket } from './command-mode.hub.js';

const OPEN = 1;

const hub = new CommandModeHub({
  send: (socket: HubSocket, message: CommandModeOutbound) => {
    const ws = socket as WebSocket;
    if (ws.readyState === OPEN) ws.send(JSON.stringify(message));
  },
  now: () => Date.now(),
});

setInterval(() => hub.sweep(), 5_000).unref();

const readKey = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() && value.length <= 1024 ? value.trim() : null
);

/** 聊天 websocket 收到 `command.*` 訊息時交給這裡。格式不對就靜默丟掉（只有本網站的頁面會送）。 */
export function handleCommandModeMessage(ws: WebSocket, type: string, data: Record<string, unknown>): void {
  const projectKey = readKey(data.projectKey);
  const profileId = readKey(data.profileId);
  switch (type) {
    case 'command.watch':
      hub.watch(ws, projectKey, profileId);
      return;
    case 'command.call':
      if (projectKey) hub.call(ws, projectKey, data.live === true, profileId);
      return;
    case 'command.share':
      if (projectKey) hub.share(ws, projectKey, data.active === true, profileId);
      return;
    case 'command.frame': {
      const frame = parseFrame(data.frame);
      if (projectKey && frame) hub.frame(ws, projectKey, frame, profileId);
      return;
    }
    default:
  }
}

export function dropCommandModeSocket(ws: WebSocket): void {
  hub.drop(ws);
}
