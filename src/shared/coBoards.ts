import { useEffect, useSyncExternalStore } from 'react';

import { api } from '@/shared/api';
import { parseBoards } from '@/shared/planBoards';
import type { CoBoardInfo, PlanBoard, PlanChatMessage } from '@/shared/planBoards';

/**
 * DHC CLI 10/14 規劃白板 Co-Work: a board shared with other people. Shared boards leave the owner's own list and live
 * together in user_preferences under the global key `dhc.coBoards`; everyone in one sees it in their board list. There
 * is no live channel: each open page saves a moment after a change and reads the others' changes every few seconds,
 * and the two copies are merged element by element the way Excalidraw itself does (higher version wins), with
 * deletions kept as deleted elements so they reach the others too. Chat messages are merged by when and who.
 */

const KEY = 'dhc.coBoards';
const SAVE_DELAY_MS = 800;
const MAX_CHAT = 60;

export type CoBoard = PlanBoard & { co: CoBoardInfo };

type Versioned = { id: string; version?: number; versionNonce?: number; isDeleted?: boolean };

/** One element per id: the higher version; on a tie the lower nonce, so every page picks the same one. */
export function mergeElements(local: ReadonlyArray<unknown>, remote: ReadonlyArray<unknown>): unknown[] {
  const merged = new Map<string, Versioned>();
  const order: string[] = [];
  for (const raw of [...local, ...remote] as Versioned[]) {
    if (!raw || typeof raw.id !== 'string') continue;
    const held = merged.get(raw.id);
    if (!held) {
      merged.set(raw.id, raw);
      order.push(raw.id);
      continue;
    }
    const a = held.version ?? 0;
    const b = raw.version ?? 0;
    if (b > a || (b === a && (raw.versionNonce ?? 0) < (held.versionNonce ?? 0))) merged.set(raw.id, raw);
  }
  return order.map((id) => merged.get(id));
}

/**
 * True when `local` holds an element the server's copy lacks, or a newer version of one. Two pages saving at
 * once each write their merge over the whole record, so the later write can drop the earlier page's change;
 * that page must save again (checked by .claude/skills/coboard-merge in the Harness優化 workspace).
 */
export function hasUnsaved(server: ReadonlyArray<unknown>, local: ReadonlyArray<unknown>): boolean {
  const held = new Map((server as Versioned[]).filter((element) => element && typeof element.id === 'string').map((element) => [element.id, element]));
  return (local as Versioned[]).some((element) => {
    if (!element || typeof element.id !== 'string') return false;
    const there = held.get(element.id);
    return !there || (element.version ?? 0) > (there.version ?? 0);
  });
}

/** True when merging `remote` into `local` changes anything. */
export function elementsDiffer(local: ReadonlyArray<unknown>, merged: ReadonlyArray<unknown>): boolean {
  if (local.length !== merged.length) return true;
  return merged.some((element, index) => element !== local[index]);
}

const chatKey = (message: PlanChatMessage) => `${message.at ?? ''}|${message.role}|${message.by ?? ''}|${message.text}`;

/** Both sides' messages once each, oldest first (messages from before timestamps keep their place at the top). */
export function mergeChat(local: PlanChatMessage[], remote: PlanChatMessage[]): PlanChatMessage[] {
  const seen = new Set<string>();
  const all: PlanChatMessage[] = [];
  for (const message of [...local, ...remote]) {
    const key = chatKey(message);
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(message);
  }
  const untimed = all.filter((message) => !message.at);
  const timed = all.filter((message) => message.at).sort((a, b) => a.at!.localeCompare(b.at!));
  return [...untimed, ...timed].slice(-MAX_CHAT);
}

/**
 * The canvas back to `snapshot` in a way the merge keeps: every element gets a version above what is on the canvas
 * now, and anything added since is marked deleted rather than dropped.
 */
export function restoreTo(current: ReadonlyArray<unknown>, snapshot: ReadonlyArray<unknown>): unknown[] {
  const now = new Map((current as Versioned[]).map((element) => [element.id, element]));
  const kept = new Set((snapshot as Versioned[]).map((element) => element.id));
  const bump = (element: Versioned, isDeleted?: boolean) => ({
    ...element,
    ...(isDeleted ? { isDeleted: true } : {}),
    version: Math.max(element.version ?? 0, now.get(element.id)?.version ?? 0) + 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
  });
  return [
    ...(snapshot as Versioned[]).map((element) => bump(element)),
    ...(current as Versioned[]).filter((element) => !kept.has(element.id) && !element.isDeleted).map((element) => bump(element, true)),
  ];
}

function parseInfo(value: unknown): CoBoardInfo | null {
  const raw = (value && typeof value === 'object' ? value : null) as Partial<CoBoardInfo> | null;
  if (!raw || typeof raw.ownerProjectId !== 'string' || !Array.isArray(raw.members)) return null;
  const members = Array.from(new Set(raw.members.filter((id): id is string => typeof id === 'string' && id !== raw.ownerProjectId)));
  if (members.length === 0) return null;
  const info: CoBoardInfo = { ownerProjectId: raw.ownerProjectId, members };
  if (raw.invites && typeof raw.invites === 'object') {
    const invites: NonNullable<CoBoardInfo['invites']> = {};
    for (const member of members) {
      const invite = (raw.invites as Record<string, { from?: unknown; message?: unknown; at?: unknown } | null>)[member];
      if (invite && typeof invite.from === 'string') {
        invites[member] = { from: invite.from, message: typeof invite.message === 'string' ? invite.message : '', at: typeof invite.at === 'string' ? invite.at : '' };
      }
    }
    if (Object.keys(invites).length > 0) info.invites = invites;
  }
  return info;
}

export function parseCoBoards(value: unknown): CoBoard[] {
  const raw = value && typeof value === 'object' ? (value as { items?: unknown }).items : null;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const co = parseInfo((item as { co?: unknown } | null)?.co);
    const [board] = co ? parseBoards({ items: [item] }, MAX_CHAT) : [];
    return board && co ? [{ ...board, co }] : [];
  });
}

/** The shared boards this person owns or is in. */
export const boardsFor = (boards: CoBoard[], projectId: string) => (
  boards.filter((board) => board.co.ownerProjectId === projectId || board.co.members.includes(projectId))
);

async function fetchCoBoards(): Promise<CoBoard[]> {
  const response = await api.user.preferences();
  if (!response.ok) throw new Error(`Failed to load preferences (${response.status})`);
  const payload = (await response.json()) as { preferences?: Record<string, unknown> };
  return parseCoBoards(payload.preferences?.[KEY]);
}

export async function loadCoBoards(projectId: string | null): Promise<CoBoard[]> {
  return projectId ? boardsFor(await fetchCoBoards(), projectId) : [];
}

/** A content save merged into the server's copy; who is in the board stays as the server has it. */
export function mergeBoard(server: CoBoard, local: CoBoard): CoBoard {
  const newer = local.updatedAt.localeCompare(server.updatedAt) >= 0 ? local : server;
  return {
    ...server,
    name: newer.name,
    mode: newer.mode,
    elements: mergeElements(server.elements, local.elements),
    chat: mergeChat(server.chat, local.chat),
    updatedAt: newer.updatedAt,
  };
}

type Change = (board: CoBoard | undefined) => CoBoard | null;

/**
 * Writes to the shared record, one at a time: each re-reads the server's copy and applies its change to that, so a
 * change made on another page in between stays. Content saves wait a moment after the last edit.
 */
export function createCoBoardSaver(onError: () => void) {
  const pendingContent = new Map<string, CoBoard>();
  let timer: number | null = null;
  let chain: Promise<void> = Promise.resolve();

  const write = (changes: Array<[string, Change]>) => {
    chain = chain.then(async () => {
      try {
        const boards = await fetchCoBoards();
        const byId = new Map(boards.map((board) => [board.id, board]));
        for (const [id, change] of changes) {
          const next = change(byId.get(id));
          if (next) byId.set(id, next);
          else byId.delete(id);
        }
        const response = await api.user.savePreferences({ [KEY]: { items: [...byId.values()] } });
        if (!response.ok) throw new Error(`Failed to save shared boards (${response.status})`);
      } catch (error) {
        console.error('[CoBoards] Failed to save:', error);
        onError();
      }
    });
    return chain;
  };

  const flush = () => {
    timer = null;
    if (pendingContent.size === 0) return chain;
    const boards = [...pendingContent.values()];
    pendingContent.clear();
    // A board no longer on the server was unshared or deleted meanwhile; the save does not bring it back.
    return write(boards.map((local) => [local.id, (server) => (server ? mergeBoard(server, local) : null)]));
  };

  return {
    save(board: CoBoard) {
      pendingContent.set(board.id, board);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { void flush(); }, SAVE_DELAY_MS);
    },
    flush() {
      if (timer !== null) window.clearTimeout(timer);
      return flush();
    },
    /** Membership and other record changes, written right away (after any waiting content save). */
    change(id: string, change: Change) {
      if (timer !== null) window.clearTimeout(timer);
      void flush();
      return write([[id, change]]);
    },
  };
}

/** Shares exactly with `members` (an empty list ends sharing); new members, or everyone when there is a note, get an invitation. */
export function withMembers(board: CoBoard | PlanBoard, owner: string, members: string[], invite: { from: string; message: string }): CoBoard | null {
  const cleaned = Array.from(new Set(members.filter((id) => id !== owner)));
  if (cleaned.length === 0) return null;
  const before = 'co' in board && board.co ? board.co : null;
  const message = invite.message.trim();
  const at = new Date().toISOString();
  const invites: NonNullable<CoBoardInfo['invites']> = {};
  for (const member of cleaned) {
    const isNew = !before?.members.includes(member);
    if (isNew || message) invites[member] = { from: invite.from, message, at };
    else if (before?.invites?.[member]) invites[member] = before.invites[member];
  }
  const co: CoBoardInfo = { ownerProjectId: owner, members: cleaned };
  if (Object.keys(invites).length > 0) co.invites = invites;
  return { ...board, co };
}

export function withoutMember(board: CoBoard, member: string): CoBoard | null {
  const members = board.co.members.filter((id) => id !== member);
  if (members.length === 0) return null;
  const { [member]: _gone, ...invites } = board.co.invites ?? {};
  const co: CoBoardInfo = { ...board.co, members };
  if (Object.keys(invites).length > 0) co.invites = invites;
  else delete co.invites;
  return { ...board, co };
}

/** Back to a personal board (owner stops sharing): deleted elements and the record fields are left behind. */
export function toPersonal(board: CoBoard): PlanBoard {
  const { co: _co, ...rest } = board;
  return { ...rest, elements: rest.elements.filter((element) => !(element as Versioned).isDeleted) };
}

/** A shared board this person has not opened since being invited (opening it clears the invitation). */
export type BoardInvite = { boardId: string; name: string; from: string; message: string; at: string };

const INVITE_POLL_MS = 60_000;
const NO_INVITES: BoardInvite[] = [];
let invites: { person: string | null; list: BoardInvite[] } = { person: null, list: NO_INVITES };
const inviteListeners = new Set<() => void>();
let inviteUsers = 0;
let inviteTimer: number | null = null;
let invitePerson: string | null = null;

export function invitesFor(boards: CoBoard[], person: string): BoardInvite[] {
  return boards.flatMap((board) => {
    const invite = board.co.invites?.[person];
    return invite ? [{ boardId: board.id, name: board.name, from: invite.from, message: invite.message, at: invite.at }] : [];
  });
}

async function loadInvites(): Promise<void> {
  const person = invitePerson;
  if (!person || document.visibilityState !== 'visible') return;
  let list: BoardInvite[];
  try { list = invitesFor(await loadCoBoards(person), person); } catch { return; }
  if (person !== invitePerson) return;
  const same = invites.person === person && invites.list.length === list.length
    && invites.list.every((item, index) => item.boardId === list[index].boardId && item.at === list[index].at);
  if (same) return;
  invites = { person, list: list.length > 0 ? list : NO_INVITES };
  inviteListeners.forEach((listener) => listener());
}

/** Re-reads the invitations now (after opening a board, so the reminder goes away without waiting a minute). */
export const refreshBoardInvites = () => { void loadInvites(); };

/** Unopened board invitations for `person`, read once a minute while some component wants them. */
export function useBoardInvites(person: string | null): BoardInvite[] {
  useEffect(() => {
    invitePerson = person;
    inviteUsers += 1;
    void loadInvites();
    if (inviteTimer === null) {
      inviteTimer = window.setInterval(() => { void loadInvites(); }, INVITE_POLL_MS);
      document.addEventListener('visibilitychange', refreshBoardInvites);
    }
    return () => {
      inviteUsers -= 1;
      if (inviteUsers === 0 && inviteTimer !== null) {
        window.clearInterval(inviteTimer);
        inviteTimer = null;
        document.removeEventListener('visibilitychange', refreshBoardInvites);
      }
    };
  }, [person]);
  return useSyncExternalStore(
    (listener) => { inviteListeners.add(listener); return () => { inviteListeners.delete(listener); }; },
    () => (person && invites.person === person ? invites.list : NO_INVITES),
    () => NO_INVITES,
  );
}
