import { useSyncExternalStore } from 'react';

import { api } from '@/shared/api';
import type { LLMProvider } from '@/shared/types';

/**
 * DHC CLI 10/08 Co-workspace: a session shared with other people. A person is a workspace project, so sharing
 * lists the session under each member's project too; it keeps running in the owner's folder. One record per
 * shared session, in user_preferences under the global key `dhc.coSessions`. A save re-reads the server's copy
 * first, like the to-do lists, so a share made on another device stays.
 *
 * The same load also reads who each person is: the profile linked to their project gives the name and the
 * avatar, which is what the sidebar and the chat bubbles show for a shared session.
 */
export type CoSession = {
  ownerProjectId: string;
  members: string[];
  sharedAt: string;
  /** The session's name when it was shared, so a member's sidebar can list it without loading the owner's sessions. */
  title: string;
  provider: LLMProvider;
  /**
   * 10/12: the invitations not yet opened, by member. Sharing (or sharing again with a message) gives each new
   * member one; opening the session or leaving it removes theirs.
   */
  invites?: Record<string, CoInvite>;
  /**
   * 10/12 靜音模式: the participants (owner included) who muted this session — no invitation card, no amber lights,
   * no browser notification and no waiting icon for them, however much the others use it. Theirs to switch back.
   */
  muted?: string[];
};

/** `from` is the project of whoever shared; `message` may be empty. */
export type CoInvite = {
  from: string;
  message: string;
  at: string;
};

export type CoSessions = Record<string, CoSession>;

/** `avatarId` is null until that person's profile picks an avatar. */
export type CoPerson = { name: string; avatarId: string | null };

const KEY = 'dhc.coSessions';
/**
 * 10/12: who shared the session with whom, with the message, and who left — shown in the chat itself. Kept apart
 * from the share records so opening, 靜音 or 退出 never loses a message, and the record ending does not either.
 */
const LOG_KEY = 'dhc.coLog';
const PROFILES_KEY = 'dhc.profiles';
const RELOAD_ON_FOCUS_MIN_MS = 30_000;
/** 10/12: an invitation reaches an open page within a minute, without a refresh or a tab switch. */
const POLL_VISIBLE_MS = 60_000;
const EMPTY: CoSessions = {};
const NO_PEOPLE: ReadonlyMap<string, CoPerson> = new Map();
const NO_SHARED: ReadonlyArray<readonly [string, CoSession]> = [];

export function parseCoSessions(value: unknown): CoSessions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY;
  const parsed: CoSessions = {};
  for (const [sessionId, raw] of Object.entries(value as Record<string, unknown>)) {
    const record = raw as Partial<CoSession> | null;
    if (!record || typeof record.ownerProjectId !== 'string' || !Array.isArray(record.members)) continue;
    const members = record.members.filter((member): member is string => (
      typeof member === 'string' && member !== record.ownerProjectId
    ));
    if (members.length === 0) continue;
    parsed[sessionId] = {
      ownerProjectId: record.ownerProjectId,
      members: Array.from(new Set(members)),
      sharedAt: typeof record.sharedAt === 'string' ? record.sharedAt : '',
      title: typeof record.title === 'string' ? record.title : '',
      provider: typeof record.provider === 'string' ? record.provider : 'claude',
    };
    const invites = parseInvites(record.invites, parsed[sessionId].members);
    if (invites) parsed[sessionId].invites = invites;
    const muted = keepParticipants(record.muted, parsed[sessionId]);
    if (muted.length > 0) parsed[sessionId].muted = muted;
  }
  return parsed;
}

/** The muted list, kept to people still in the session. */
function keepParticipants(value: unknown, session: Pick<CoSession, 'ownerProjectId' | 'members'>): string[] {
  if (!Array.isArray(value)) return [];
  const participants = new Set([session.ownerProjectId, ...session.members]);
  return Array.from(new Set(value.filter((id): id is string => typeof id === 'string' && participants.has(id))));
}

function parseInvites(value: unknown, members: string[]): Record<string, CoInvite> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const invites: Record<string, CoInvite> = {};
  for (const member of members) {
    const raw = (value as Record<string, Partial<CoInvite> | null>)[member];
    if (!raw || typeof raw.from !== 'string') continue;
    invites[member] = {
      from: raw.from,
      message: typeof raw.message === 'string' ? raw.message : '',
      at: typeof raw.at === 'string' ? raw.at : '',
    };
  }
  return Object.keys(invites).length > 0 ? invites : null;
}

/** Who each project is: the profile linked to it gives the name and, when one was picked, the avatar. */
export function parseCoPeople(rows: Record<string, unknown>): ReadonlyMap<string, CoPerson> {
  const profiles = rows[PROFILES_KEY];
  if (!Array.isArray(profiles)) return NO_PEOPLE;
  const people = new Map<string, CoPerson>();
  for (const profile of profiles as Array<{ id?: unknown; name?: unknown; projectId?: unknown }>) {
    if (!profile || typeof profile.id !== 'string' || typeof profile.name !== 'string') continue;
    if (typeof profile.projectId !== 'string') continue;
    const avatar = rows[`p:${profile.id}:userAvatar`];
    people.set(profile.projectId, { name: profile.name, avatarId: typeof avatar === 'string' && avatar ? avatar : null });
  }
  return people;
}

let sessions: CoSessions = EMPTY;
let people: ReadonlyMap<string, CoPerson> = NO_PEOPLE;
let profilePeople: ReadonlyMap<string, CoPerson> = NO_PEOPLE;
let projectNames: ReadonlyMap<string, string> = new Map();
let shareTarget: CoShareTarget | null = null;
let sharedByMember = new Map<string, ReadonlyArray<readonly [string, CoSession]>>();
let writesInFlight = 0;
let writeChain: Promise<void> = Promise.resolve();
let lastLoadAt = 0;
let logs: CoLogs = {};
let logWritesInFlight = 0;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const notify = () => listeners.forEach((listener) => listener());

/** A person without a linked profile still has a name: their project folder's. */
function rebuildPeople(): void {
  const merged = new Map<string, CoPerson>();
  for (const [projectId, name] of projectNames) merged.set(projectId, { name, avatarId: null });
  for (const [projectId, person] of profilePeople) merged.set(projectId, person);
  people = merged;
}

/** The sidebar hands over the workspace projects, so every person has at least a name. */
export function setCoProjectNames(projects: ReadonlyArray<{ projectId: string; displayName: string }>): void {
  const signature = (names: ReadonlyMap<string, string>) => JSON.stringify(Array.from(names));
  const next = new Map(projects.map((project) => [project.projectId, project.displayName]));
  if (signature(next) === signature(projectNames)) return;
  projectNames = next;
  rebuildPeople();
  notify();
}

function setSessions(next: CoSessions): void {
  sessions = next;
  // Rebuilt once per change so each member's list keeps one array identity between renders.
  const byMember = new Map<string, Array<readonly [string, CoSession]>>();
  for (const entry of Object.entries(next)) {
    for (const member of entry[1].members) {
      byMember.set(member, [...(byMember.get(member) ?? []), entry]);
    }
  }
  sharedByMember = byMember;
  notify();
}

async function fetchServerRows(): Promise<Record<string, unknown>> {
  const response = await api.user.preferences();
  if (!response.ok) throw new Error(`Failed to load preferences (${response.status})`);
  const payload = (await response.json()) as { preferences?: Record<string, unknown> };
  return payload.preferences ?? {};
}

export async function loadCoSessions(): Promise<void> {
  lastLoadAt = Date.now();
  try {
    const rows = await fetchServerRows();
    profilePeople = parseCoPeople(rows);
    rebuildPeople();
    // A save in flight already shows its result; the server's older copy must not flash back over it.
    if (logWritesInFlight === 0) logs = parseCoLogs(rows[LOG_KEY]);
    setSessions(writesInFlight > 0 ? sessions : parseCoSessions(rows[KEY]));
  } catch (error) {
    console.error('[CoSessions] Failed to load shared sessions:', error);
  }
}

/** Loads the shared sessions now and whenever the tab comes back into view; returns the cleanup. */
export function startCoSessionsSync(): () => void {
  void loadCoSessions();
  const reloadWhenVisible = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastLoadAt > RELOAD_ON_FOCUS_MIN_MS) {
      void loadCoSessions();
    }
  };
  document.addEventListener('visibilitychange', reloadWhenVisible);
  const poll = window.setInterval(reloadWhenVisible, POLL_VISIBLE_MS);
  return () => {
    document.removeEventListener('visibilitychange', reloadWhenVisible);
    window.clearInterval(poll);
  };
}

function updateCoSessions(change: (current: CoSessions) => CoSessions): Promise<boolean> {
  setSessions(change(sessions));
  writesInFlight += 1;
  const write = writeChain.then(async () => {
    try {
      const next = change(parseCoSessions((await fetchServerRows())[KEY]));
      const response = await api.user.savePreferences({ [KEY]: next });
      if (!response.ok) throw new Error(`Failed to save shared sessions (${response.status})`);
      if (writesInFlight === 1) setSessions(next);
      return true;
    } catch (error) {
      console.error('[CoSessions] Failed to save shared sessions:', error);
      alert('共享設定沒有存到伺服器，請重新整理頁面後再試一次。');
      return false;
    } finally {
      writesInFlight -= 1;
    }
  });
  writeChain = write.then(() => undefined);
  return write;
}

type SharedSession = Pick<CoSession, 'ownerProjectId' | 'title' | 'provider'>;

/** The session whose 「Co-Work」 dialog is open. */
export type CoShareTarget = SharedSession & { sessionId: string };

export function openCoShareDialog(target: CoShareTarget | null): void {
  shareTarget = target;
  notify();
}

export function useCoShareTarget(): CoShareTarget | null {
  return useSyncExternalStore(subscribe, () => shareTarget, () => null);
}

/**
 * Shares the session with exactly these people; an empty list stops sharing it. Each person newly added gets an
 * invitation from `invite.from`; with a message, everyone picked gets it, so a note can go to people already in.
 */
export function setCoSessionMembers(
  sessionId: string,
  session: SharedSession,
  members: string[],
  invite?: { from: string; message: string },
): Promise<boolean> {
  const cleaned = Array.from(new Set(members.filter((member) => member !== session.ownerProjectId)));
  const message = invite?.message.trim() ?? '';
  const at = new Date().toISOString();
  const before = sessions[sessionId]?.members ?? [];
  const added = cleaned.filter((member) => !before.includes(member));
  if (invite && (added.length > 0 || message)) {
    appendCoLog(sessionId, { kind: 'share', from: invite.from, to: message ? cleaned : added, message, at });
  }
  return updateCoSessions((current) => {
    const { [sessionId]: existing, ...rest } = current;
    if (cleaned.length === 0) return rest;
    const invites: Record<string, CoInvite> = {};
    for (const member of cleaned) {
      const isNew = !existing?.members.includes(member);
      if (invite && (isNew || message)) invites[member] = { from: invite.from, message, at };
      else if (existing?.invites?.[member]) invites[member] = existing.invites[member];
    }
    const next: CoSession = { ...session, members: cleaned, sharedAt: existing?.sharedAt || at };
    if (Object.keys(invites).length > 0) next.invites = invites;
    const muted = keepParticipants(existing?.muted, next);
    if (muted.length > 0) next.muted = muted;
    return { ...rest, [sessionId]: next };
  });
}

/** 靜音模式 on or off for one participant; the unopened invitation (if any) stays and shows again when unmuted. */
export function setCoMuted(sessionId: string, person: string, muted: boolean): void {
  if (!sessions[sessionId] || isCoMuted(sessionId, person) === muted) return;
  void updateCoSessions((current) => {
    const record = current[sessionId];
    if (!record) return current;
    const others = (record.muted ?? []).filter((id) => id !== person);
    const list = muted ? [...others, person] : others;
    const next: CoSession = { ...record };
    if (list.length > 0) next.muted = list;
    else delete next.muted;
    return { ...current, [sessionId]: next };
  });
}

export function isCoMuted(sessionId: string | null | undefined, person: string | null | undefined): boolean {
  return Boolean(sessionId && person && sessions[sessionId]?.muted?.includes(person));
}

/** A shared session was renamed: everyone in it sees the new name within a minute, no reload needed. */
export function renameCoSession(sessionId: string, title: string): void {
  if (!sessions[sessionId] || sessions[sessionId].title === title) return;
  void updateCoSessions((current) => (
    current[sessionId] ? { ...current, [sessionId]: { ...current[sessionId], title } } : current
  ));
}

/** The member opened the session: their invitation is gone (its message stays in the Co-Work log). */
export function dismissCoInvite(sessionId: string, member: string): void {
  if (!sessions[sessionId]?.invites?.[member]) return;
  void updateCoSessions((current) => {
    const record = current[sessionId];
    if (!record?.invites?.[member]) return current;
    const { [member]: _opened, ...invites } = record.invites;
    const next: CoSession = { ...record };
    if (Object.keys(invites).length > 0) next.invites = invites;
    else delete next.invites;
    return { ...current, [sessionId]: next };
  });
}

/** 退出 Co-Work: the member stops seeing the session; the last one out ends the sharing. */
export function leaveCoSession(sessionId: string, member: string): Promise<boolean> {
  if (sessions[sessionId]?.members.includes(member)) {
    appendCoLog(sessionId, { kind: 'leave', from: member, to: [], message: '', at: new Date().toISOString() });
  }
  return updateCoSessions((current) => {
    const { [sessionId]: record, ...rest } = current;
    if (!record) return current;
    const members = record.members.filter((id) => id !== member);
    if (members.length === 0) return rest;
    const next: CoSession = { ...record, members };
    const muted = keepParticipants(record.muted, next);
    if (muted.length > 0) next.muted = muted;
    else delete next.muted;
    if (record.invites) {
      const { [member]: _left, ...invites } = record.invites;
      if (Object.keys(invites).length > 0) next.invites = invites;
      else delete next.invites;
    }
    return { ...rest, [sessionId]: next };
  });
}

/** A deleted session stops being listed under the people it was shared with. */
export function forgetCoSession(sessionId: string): void {
  if (!sessions[sessionId]) return;
  void updateCoSessions(({ [sessionId]: _removed, ...rest }) => rest);
}

export type CoLogEntry = { kind: 'share' | 'leave'; from: string; to: string[]; message: string; at: string };
export type CoLogs = Record<string, CoLogEntry[]>;
const NO_LOG: CoLogEntry[] = [];

export function parseCoLogs(value: unknown): CoLogs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const parsed: CoLogs = {};
  for (const [sessionId, entries] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(entries)) continue;
    const list = entries.flatMap((raw) => {
      const entry = raw as Partial<CoLogEntry> | null;
      if (!entry || typeof entry.from !== 'string' || typeof entry.at !== 'string') return [];
      return [{
        kind: entry.kind === 'leave' ? 'leave' as const : 'share' as const,
        from: entry.from,
        to: Array.isArray(entry.to) ? entry.to.filter((id): id is string => typeof id === 'string') : [],
        message: typeof entry.message === 'string' ? entry.message : '',
        at: entry.at,
      }];
    });
    if (list.length > 0) parsed[sessionId] = list.sort((a, b) => a.at.localeCompare(b.at));
  }
  return parsed;
}

/** Adds one entry; like the share records, the save re-reads the server's copy first so other devices' entries stay. */
function appendCoLog(sessionId: string, entry: CoLogEntry): void {
  const add = (current: CoLogs): CoLogs => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), entry] });
  logs = add(logs);
  notify();
  logWritesInFlight += 1;
  writeChain = writeChain.then(async () => {
    try {
      const next = add(parseCoLogs((await fetchServerRows())[LOG_KEY]));
      const response = await api.user.savePreferences({ [LOG_KEY]: next });
      if (!response.ok) throw new Error(`Failed to save the Co-Work log (${response.status})`);
      if (logWritesInFlight === 1) logs = next;
    } catch (error) {
      console.error('[CoSessions] Failed to save the Co-Work log:', error);
    } finally {
      logWritesInFlight -= 1;
      notify();
    }
  });
}

/** This session's Co-Work log, oldest first. */
export function useCoLog(sessionId: string | null | undefined): CoLogEntry[] {
  return useSyncExternalStore(subscribe, () => (sessionId ? logs[sessionId] ?? NO_LOG : NO_LOG), () => NO_LOG);
}

export function readCoLog(sessionId: string): CoLogEntry[] {
  return logs[sessionId] ?? NO_LOG;
}

export function readCoSession(sessionId: string | null | undefined): CoSession | null {
  return sessionId ? sessions[sessionId] ?? null : null;
}

export function useCoSession(sessionId: string | null | undefined): CoSession | null {
  return useSyncExternalStore(subscribe, () => readCoSession(sessionId), () => null);
}

/** The sessions other people shared with this project, as [sessionId, record] pairs. */
export function useSessionsSharedWith(projectId: string): ReadonlyArray<readonly [string, CoSession]> {
  return useSyncExternalStore(subscribe, () => sharedByMember.get(projectId) ?? NO_SHARED, () => NO_SHARED);
}

let invitesFor: { member: string | null; list: ReadonlyArray<CoInviteEntry> } = { member: null, list: [] };

export type CoInviteEntry = { sessionId: string; session: CoSession; invite: CoInvite };

/** This person's unopened invitations, newest first; the same array until they change. */
export function readCoInvites(member: string | null): ReadonlyArray<CoInviteEntry> {
  const list = member
    ? (sharedByMember.get(member) ?? [])
      .filter(([, session]) => session.invites?.[member])
      .map(([sessionId, session]) => ({ sessionId, session, invite: session.invites![member] }))
      .sort((a, b) => b.invite.at.localeCompare(a.invite.at))
    : [];
  const same = invitesFor.member === member
    && invitesFor.list.length === list.length
    && invitesFor.list.every((entry, index) => entry.session === list[index].session);
  if (!same) invitesFor = { member, list };
  return invitesFor.list;
}

export function useCoInvites(member: string | null): ReadonlyArray<CoInviteEntry> {
  return useSyncExternalStore(subscribe, () => readCoInvites(member), () => readCoInvites(null));
}

export function useCoPeople(): ReadonlyMap<string, CoPerson> {
  return useSyncExternalStore(subscribe, () => people, () => NO_PEOPLE);
}

/** Owner first, then the members in the order they were added. */
export const coSessionParticipants = (session: CoSession): string[] => [session.ownerProjectId, ...session.members];

const SENDER_PREFIX = /^【([^】\n]{1,30})】 ?/;

/** Marks who is speaking in a shared session, so Claude and the other people can tell. */
export function withSenderPrefix(text: string, senderName: string): string {
  const name = senderName.trim();
  return name && !SENDER_PREFIX.test(text) ? `【${name}】${text}` : text;
}

/** Splits the speaker mark off a shared session's message; null when it carries none. */
export function parseSenderPrefix(text: string): { name: string; body: string } | null {
  const match = SENDER_PREFIX.exec(text);
  return match ? { name: match[1], body: text.slice(match[0].length) } : null;
}

/**
 * Who sent a user message of a shared session, and its text without the speaker mark. A message without a mark
 * was written before the session was shared, so it is the owner's.
 */
export function resolveCoSender(
  session: CoSession,
  knownPeople: ReadonlyMap<string, CoPerson>,
  content: string,
): { person: CoPerson; body: string } {
  const parsed = parseSenderPrefix(content);
  if (!parsed) {
    return { person: knownPeople.get(session.ownerProjectId) ?? { name: '?', avatarId: null }, body: content };
  }
  const participant = coSessionParticipants(session)
    .map((projectId) => knownPeople.get(projectId))
    .find((person) => person?.name === parsed.name);
  return { person: participant ?? { name: parsed.name, avatarId: null }, body: parsed.body };
}
