/**
 * 指揮模式：手機通話中，電腦分享整個螢幕給同一個專案的手機看。
 *
 * 每個「專案＋設定檔」一間房：公司共用同一組登入，用裝置上的設定檔 id 分辨人，畫面只在同一個人的
 * 裝置之間轉送。沒有設定檔 id（還沒配對）的連線不進任何房間、不收任何東西。房裡的人分三種：
 * - caller：正在語音通話的連線（手機）。只有它在，電腦才能分享。
 * - watcher：正在看這個專案的連線（電腦、手機都算），用來收「能不能開指揮模式」的狀態。
 * - sharer：正在分享螢幕的那一條連線（最多一條）。
 *
 * 不變式：沒有 caller 就沒有 sharer，沒有 sharer 就沒有畫面。畫面只留最新一張在記憶體。
 */

/** 電腦上右鍵畫的一筆（軌跡已拍進畫面），手機據此把這張當成「有圈點」。 */
export type DeskMark = { id: string; shape: 'dot' | 'line' | 'circle'; startedAt: number; endedAt: number };

export type CommandFrame = {
  id: string;
  capturedAt: number;
  width: number;
  height: number;
  dataUrl: string;
  marks?: DeskMark[];
};

export type CommandModeState = {
  kind: 'command_mode_state';
  projectKey: string;
  /** 別條連線有人在通話（自己在通話不算），電腦據此顯示按鈕。 */
  phoneLive: boolean;
  sharing: boolean;
  youShare: boolean;
};

export type CommandFrameEvent = { kind: 'command_frame'; projectKey: string; frame: CommandFrame };

export type CommandModeOutbound = CommandModeState | CommandFrameEvent;

export type HubSocket = object;

type Caller = { lingerUntil: number | null };

type Room = {
  projectKey: string;
  callers: Map<HubSocket, Caller>;
  watchers: Set<HubSocket>;
  sharer: HubSocket | null;
  frame: CommandFrame | null;
};

export const MAX_FRAME_CHARS = 3_000_000;
// 手機網路一閃斷線再連上時，不要讓電腦那邊的分享直接被關掉（重新分享要人再選一次螢幕）。
export const CALLER_LINGER_MS = 15_000;
const FRAME_PREFIX = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;

export type HubDeps = {
  send: (socket: HubSocket, message: CommandModeOutbound) => void;
  now: () => number;
};

const roomKey = (projectKey: string, profileId: string) => `${profileId}
${projectKey}`;

export function parseFrame(value: unknown): CommandFrame | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const { id, capturedAt, width, height, dataUrl } = v;
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return null;
  if (typeof capturedAt !== 'number' || !Number.isFinite(capturedAt)) return null;
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if ((width as number) < 1 || (width as number) > 4096 || (height as number) < 1 || (height as number) > 4096) return null;
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_FRAME_CHARS || !FRAME_PREFIX.test(dataUrl)) return null;
  const marks = parseMarks(v.marks);
  if (marks === null) return null;
  return { id, capturedAt, width: width as number, height: height as number, dataUrl, ...(marks.length > 0 ? { marks } : {}) };
}

const SHAPES = new Set(['dot', 'line', 'circle']);

function parseMarks(value: unknown): DeskMark[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) return null;
  const marks: DeskMark[] = [];
  for (const item of value) {
    const m = (item ?? {}) as Record<string, unknown>;
    if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 64) return null;
    if (typeof m.shape !== 'string' || !SHAPES.has(m.shape)) return null;
    if (typeof m.startedAt !== 'number' || typeof m.endedAt !== 'number' || !Number.isFinite(m.startedAt) || !Number.isFinite(m.endedAt)) return null;
    marks.push({ id: m.id, shape: m.shape as DeskMark['shape'], startedAt: m.startedAt, endedAt: m.endedAt });
  }
  return marks;
}

export class CommandModeHub {
  private rooms = new Map<string, Room>();
  private watching = new Map<HubSocket, string>();

  constructor(private deps: HubDeps) {}

  watch(socket: HubSocket, projectKey: string | null, profileId: string | null): void {
    const key = projectKey && profileId ? roomKey(projectKey, profileId) : null;
    const previous = this.watching.get(socket);
    if (previous && previous !== key) {
      const room = this.rooms.get(previous);
      room?.watchers.delete(socket);
      if (room && room.sharer === socket) room.sharer = null;
      this.settle(previous);
    }
    if (!projectKey || !key) {
      this.watching.delete(socket);
      return;
    }
    this.watching.set(socket, key);
    this.room(projectKey, key).watchers.add(socket);
    this.settle(key);
  }

  call(socket: HubSocket, projectKey: string, live: boolean, profileId: string | null): void {
    const key = profileId ? roomKey(projectKey, profileId) : null;
    for (const [other, room] of this.rooms) {
      if (other !== key && room.callers.delete(socket)) this.settle(other);
    }
    if (!key) return;
    const room = this.room(projectKey, key);
    if (live) {
      room.callers.set(socket, { lingerUntil: null });
      room.watchers.add(socket);
      this.settle(key);
      if (room.frame) this.deps.send(socket, { kind: 'command_frame', projectKey, frame: room.frame });
    } else {
      room.callers.delete(socket);
      this.settle(key);
    }
  }

  share(socket: HubSocket, projectKey: string, active: boolean, profileId: string | null): void {
    if (!profileId) return;
    const key = roomKey(projectKey, profileId);
    const room = this.room(projectKey, key);
    room.watchers.add(socket);
    if (active) {
      if (this.liveCallers(room, socket) === 0) {
        this.settle(key);
        return;
      }
      room.sharer = socket;
      room.frame = null;
    } else if (room.sharer === socket) {
      room.sharer = null;
    }
    this.settle(key);
  }

  frame(socket: HubSocket, projectKey: string, frame: CommandFrame, profileId: string | null): boolean {
    const room = profileId ? this.rooms.get(roomKey(projectKey, profileId)) : undefined;
    if (!room || room.sharer !== socket) return false;
    room.frame = frame;
    for (const [caller, entry] of room.callers) {
      if (entry.lingerUntil === null && caller !== socket) this.deps.send(caller, { kind: 'command_frame', projectKey, frame });
    }
    return true;
  }

  drop(socket: HubSocket): void {
    this.watching.delete(socket);
    for (const [key, room] of this.rooms) {
      room.watchers.delete(socket);
      if (room.sharer === socket) room.sharer = null;
      const caller = room.callers.get(socket);
      if (caller) caller.lingerUntil = this.deps.now() + CALLER_LINGER_MS;
      this.settle(key);
    }
  }

  /** 把逾時的斷線手機清掉；由服務每幾秒呼叫一次。 */
  sweep(): void {
    const now = this.deps.now();
    for (const [key, room] of this.rooms) {
      let changed = false;
      for (const [socket, caller] of room.callers) {
        if (caller.lingerUntil !== null && caller.lingerUntil <= now) {
          room.callers.delete(socket);
          changed = true;
        }
      }
      if (changed) this.settle(key);
    }
  }

  latestFrame(projectKey: string, profileId: string): CommandFrame | null {
    return this.rooms.get(roomKey(projectKey, profileId))?.frame ?? null;
  }

  private room(projectKey: string, key: string): Room {
    let room = this.rooms.get(key);
    if (!room) {
      room = { projectKey, callers: new Map(), watchers: new Set(), sharer: null, frame: null };
      this.rooms.set(key, room);
    }
    return room;
  }

  private liveCallers(room: Room, except: HubSocket | null): number {
    let count = 0;
    for (const socket of room.callers.keys()) if (socket !== except) count += 1;
    return count;
  }

  private settle(key: string): void {
    const room = this.rooms.get(key);
    if (!room) return;
    const { projectKey } = room;
    if (room.sharer && this.liveCallers(room, room.sharer) === 0) room.sharer = null;
    if (!room.sharer) room.frame = null;
    for (const socket of room.watchers) {
      this.deps.send(socket, {
        kind: 'command_mode_state',
        projectKey,
        phoneLive: this.liveCallers(room, socket) > 0,
        sharing: room.sharer !== null,
        youShare: room.sharer === socket,
      });
    }
    if (room.callers.size === 0 && room.watchers.size === 0) this.rooms.delete(key);
  }
}
