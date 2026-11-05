import type { ServerEvent } from '@/shared/types';

/**
 * 指揮模式在聊天 websocket 上的訊息（伺服器端在 server/modules/command-mode）。
 * 送出：command.watch / command.call / command.share / command.frame（socket.ts 會替每則補上 profileId，
 * 伺服器只在 profileId 相同的連線之間轉送）。
 * 收到：command_mode_state、command_frame。
 */
/** 電腦上用滑鼠右鍵畫的一筆；軌跡已經拍進帶著它的那張畫面裡，所以不帶座標。 */
export type DeskMark = {
  id: string;
  shape: 'dot' | 'line' | 'circle';
  startedAt: number;
  endedAt: number;
};

export type CommandFrame = {
  id: string;
  capturedAt: number;
  width: number;
  height: number;
  /** data:image/jpeg;base64,... */
  dataUrl: string;
  /** 這張畫面裡拍到的電腦端雷射筆筆畫。 */
  marks?: DeskMark[];
};

export type CommandModeState = {
  kind: 'command_mode_state';
  projectKey: string;
  /** 別條連線有人在通話（自己不算）。 */
  phoneLive: boolean;
  sharing: boolean;
  youShare: boolean;
};

export type CommandFrameEvent = { kind: 'command_frame'; projectKey: string; frame: CommandFrame };

export type CommandModeOutbound =
  | { type: 'command.watch'; projectKey: string | null }
  | { type: 'command.call'; projectKey: string; live: boolean }
  | { type: 'command.share'; projectKey: string; active: boolean }
  | { type: 'command.frame'; projectKey: string; frame: CommandFrame };

export const isStateEvent = (event: ServerEvent): event is ServerEvent & CommandModeState => (
  event.kind === 'command_mode_state' && typeof event.projectKey === 'string'
);

export const isFrameEvent = (event: ServerEvent): event is ServerEvent & CommandFrameEvent => {
  const frame = event.frame as Partial<CommandFrame> | undefined;
  return event.kind === 'command_frame' && typeof event.projectKey === 'string'
    && !!frame && typeof frame.id === 'string' && typeof frame.dataUrl === 'string';
};
