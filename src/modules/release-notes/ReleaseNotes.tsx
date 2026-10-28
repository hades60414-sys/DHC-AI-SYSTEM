import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { BellDot, ChevronDown, List, MousePointerClick, Palette, Puzzle, RefreshCw, Rocket, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/shared/utils';

// Bottom of the right-edge stack, below 待辦 and 自選功能 (TodoDock, WishPool).
const DESKTOP_HANDLE_STYLE: CSSProperties = { top: '90%', transform: 'translateY(-50%)' };
const MOBILE_HANDLE_STYLE: CSSProperties = { bottom: '50%' };
// Lives in dist/ next to index.html, so a note can be added or relabelled without a rebuild.
const NOTES_URL = '/dhc-releases.json';

type Level = 'high' | 'mid' | 'low';
type Kind = 'feature' | 'ui' | 'ux';
type ReleaseEntry = { id: string; at: string; level: Level; kind?: Kind; title: string; detail?: string };

const LEVELS: { level: Level; label: string; dot: string }[] = [
  { level: 'high', label: '重要', dot: 'bg-red-500' },
  { level: 'mid', label: '一般', dot: 'bg-amber-400' },
  { level: 'low', label: '小修', dot: 'bg-emerald-500' },
];
const KINDS: { kind: Kind; label: string; Icon: LucideIcon }[] = [
  { kind: 'feature', label: '功能', Icon: Puzzle },
  { kind: 'ui', label: 'UI', Icon: Palette },
  { kind: 'ux', label: 'UX', Icon: MousePointerClick },
];
const kindOf = (kind?: Kind) => KINDS.find((item) => item.kind === kind);
// Filter chips: no focus outline; the chosen ones already stand out by their background.
const CHIP = 'flex items-center gap-1.5 rounded-md px-2 py-0.5 outline-none';
const CHIP_ON = 'bg-muted font-medium text-foreground';
const CHIP_OFF = 'text-foreground hover:bg-muted';
const dotOf = (level: Level) => LEVELS.find((item) => item.level === level)?.dot ?? 'bg-muted-foreground';

const parseEntries = (data: unknown): ReleaseEntry[] => {
  const list = (data as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list)) return [];
  return list
    // "pending" = written ahead of a server restart; it only shows once the flag is removed.
    .filter((item): item is ReleaseEntry => Boolean(item) && typeof item.title === 'string' && typeof item.at === 'string' && !item.pending)
    .map((item) => ({ ...item, level: LEVELS.some((l) => l.level === item.level) ? item.level : 'mid' }))
    .sort((a, b) => b.at.localeCompare(a.at));
};

const LEVEL_KEY = 'dhc.releaseLevelFilter';
const KIND_KEY = 'dhc.releaseKindFilter';

const readStored = <T extends string>(key: string, allowed: T[]): T | null => {
  try {
    const value = localStorage.getItem(key);
    return allowed.find((item) => item === value) ?? null;
  } catch {
    return null;
  }
};

const writeStored = (key: string, value: string | null) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Storage blocked: the filter lasts for this page load.
  }
};

// 本次更新 = what this browser got with the version it now runs. Opening and closing changes nothing; only moving onto
// a newer version (a new bundle after F5) replaces the list. Entries are keyed id@at, so adding a line to a feature
// (newer at) brings it back.
//   bundle   = the version this browser runs
//   baseline = entries already there before that version (not 本次更新)
//   known    = entries listed while on that version; becomes the baseline of the next one
const VERSION_KEY = 'dhc.releaseVersion';
const SCOPE_KEY = 'dhc.releaseScope';
type VersionRecord = { bundle: string; baseline: string[]; known: string[] };
const readVersion = (): VersionRecord | null => {
  try {
    const parsed = JSON.parse(localStorage.getItem(VERSION_KEY) ?? 'null') as Partial<VersionRecord> | null;
    return parsed && typeof parsed.bundle === 'string' && Array.isArray(parsed.baseline) && Array.isArray(parsed.known)
      ? (parsed as VersionRecord)
      : null;
  } catch {
    return null;
  }
};

const seenKey = (entry: ReleaseEntry) => `${entry.id}@${entry.at}`;

const BUNDLE_PATTERN = /\/assets\/(index-[\w-]+\.js)/;
const runningBundle = () =>
  document.querySelector<HTMLScriptElement>('script[src*="/assets/index-"]')?.src.match(BUNDLE_PATTERN)?.[1] ?? 'dev';

/** True when the server now hands out a different main bundle than the one this page loaded. */
const checkNewerBundle = async (): Promise<boolean> => {
  const running = runningBundle();
  if (running === 'dev') return false;
  const html = await (await fetch('/', { cache: 'no-store' })).text();
  const served = html.match(BUNDLE_PATTERN)?.[1];
  return Boolean(served) && served !== running;
};

/** Works out this version's baseline and records what is listed now. */
const settleVersion = (list: ReleaseEntry[], pageIsStale: boolean): Set<string> => {
  const keys = list.map(seenKey);
  const bundle = runningBundle();
  const stored = readVersion();
  let record: VersionRecord;
  if (!stored) {
    // First visit: only the latest day's entries count as 本次更新.
    const latestDay = list[0]?.at.slice(0, 10);
    record = { bundle, baseline: list.filter((entry) => entry.at.slice(0, 10) !== latestDay).map(seenKey), known: keys };
  } else if (stored.bundle !== bundle) {
    record = { bundle, baseline: stored.known, known: keys };
  } else {
    // A stale page already sees entries of a version it has not loaded; keep them out of known, so they are still
    // 本次更新 after the F5 that brings that version.
    record = { ...stored, known: pageIsStale ? stored.known : keys };
  }
  writeStored(VERSION_KEY, JSON.stringify(record));
  return new Set(record.baseline);
};

/** DHC CLI 版本更新: a right-edge handle between 待辦 and 功能許願池 listing what went live, with an F5 hint when this page is stale. */
export default function ReleaseNotes({ isMobile }: { isMobile: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const [entries, setEntries] = useState<ReleaseEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [needsReload, setNeedsReload] = useState(false);
  // The chosen filters stick (per browser), so someone who only reads 重要 keeps seeing just that.
  const [filter, setFilterState] = useState<Level | null>(() => readStored(LEVEL_KEY, LEVELS.map((item) => item.level)));
  const [kindFilter, setKindFilterState] = useState<Kind | null>(() => readStored(KIND_KEY, KINDS.map((item) => item.kind)));
  const setFilter = (value: Level | null) => { setFilterState(value); writeStored(LEVEL_KEY, value); };
  const setKindFilter = (value: Kind | null) => { setKindFilterState(value); writeStored(KIND_KEY, value); };
  const [onlyNew, setOnlyNewState] = useState(() => readStored(SCOPE_KEY, ['new']) === 'new');
  const setOnlyNew = (value: boolean) => { setOnlyNewState(value); writeStored(SCOPE_KEY, value ? 'new' : null); };
  const [baseline, setBaseline] = useState<Set<string> | null>(null);

  // Fetched on every open, so the list and the F5 hint are as fresh as the server.
  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    setFailed(false);
    const notes = fetch(NOTES_URL, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then(parseEntries);
    const stale = checkNewerBundle().catch(() => false);
    stale.then((newer) => { if (!cancelled) setNeedsReload(newer); });
    Promise.all([notes, stale])
      .then(([list, newer]) => {
        if (cancelled) return;
        setBaseline(settleVersion(list, newer));
        setEntries(list);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      cancelled = true;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [isOpen]);

  const isNew = (entry: ReleaseEntry) => baseline !== null && !baseline.has(seenKey(entry));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggleExpanded = (key: string) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const newCount = (entries ?? []).filter(isNew).length;
  const shown = (entries ?? []).filter((entry) => (
    (!onlyNew || isNew(entry)) && (!filter || entry.level === filter) && (!kindFilter || entry.kind === kindFilter)
  ));
  const nothingChosen = !onlyNew && filter === null && kindFilter === null;

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        aria-label="打開版本更新"
        title="版本更新"
        className="fixed right-0 z-50 rounded-l-md border border-gray-200 bg-white p-2 text-gray-600 shadow-lg transition-colors hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700"
        style={isMobile ? MOBILE_HANDLE_STYLE : DESKTOP_HANDLE_STYLE}
      >
        <Rocket className="h-5 w-5" />
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <button
            type="button"
            aria-label="關閉版本更新"
            onClick={() => setIsOpen(false)}
            className="absolute inset-0 bg-background/60 backdrop-blur-sm"
          />
          <div
            role="dialog"
            aria-label="版本更新"
            className={cn(
              'relative flex flex-col overflow-hidden border border-border bg-background shadow-xl',
              isMobile ? 'h-full w-full' : 'max-h-[85vh] w-[46rem] max-w-[calc(100vw-2rem)] rounded-lg',
            )}
          >
            <div className="flex h-12 flex-shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3">
              <Rocket className="h-4 w-4 text-primary" />
              <span className="text-sm font-semibold text-foreground">版本更新</span>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                aria-label="關閉"
                className="ml-auto rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {needsReload && (
              <div className="flex flex-shrink-0 items-center gap-2 border-b border-primary/30 bg-primary/10 px-3 py-2 text-xs text-foreground">
                <span className="min-w-0 flex-1">有新功能上線，這個頁面還是舊版。按 F5 重新整理就會換新。</span>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1 font-medium text-primary-foreground hover:bg-primary/90"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  重新整理
                </button>
              </div>
            )}

            <div className="flex flex-shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-2 text-xs">
              <button
                type="button"
                onClick={() => { setOnlyNew(false); setFilter(null); setKindFilter(null); }}
                aria-pressed={nothingChosen}
                className={cn(CHIP, nothingChosen ? CHIP_ON : CHIP_OFF)}
              >
                <List className="h-3.5 w-3.5" />
                全部
              </button>
              <button
                type="button"
                onClick={() => setOnlyNew(!onlyNew)}
                aria-pressed={onlyNew}
                title="你目前這個版本帶來的更新；下次更新上線、按 F5 後才換成新的"
                className={cn(CHIP, onlyNew ? CHIP_ON : CHIP_OFF)}
              >
                <BellDot className="h-3.5 w-3.5" />
                本次更新
                {newCount > 0 && (
                  <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground">{newCount}</span>
                )}
              </button>
              <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
              {KINDS.map((item) => (
                <button
                  key={item.kind}
                  type="button"
                  onClick={() => setKindFilter(kindFilter === item.kind ? null : item.kind)}
                  aria-pressed={kindFilter === item.kind}
                  className={cn(CHIP, kindFilter === item.kind ? CHIP_ON : CHIP_OFF)}
                >
                  <item.Icon className="h-3.5 w-3.5" />
                  {item.label}
                </button>
              ))}
              <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
              {LEVELS.map((item) => (
                <button
                  key={item.level}
                  type="button"
                  onClick={() => setFilter(filter === item.level ? null : item.level)}
                  aria-pressed={filter === item.level}
                  className={cn(CHIP, filter === item.level ? CHIP_ON : CHIP_OFF)}
                >
                  <span className={cn('h-2 w-2 rounded-full', item.dot)} />
                  {item.label}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {failed ? (
                <p className="py-3 text-center text-xs text-muted-foreground">讀不到更新紀錄，稍後再開一次。</p>
              ) : entries === null ? (
                <p className="py-3 text-center text-xs text-muted-foreground">載入中…</p>
              ) : shown.length === 0 ? (
                <p className="py-3 text-center text-xs text-muted-foreground">{onlyNew && newCount === 0 ? '這個版本沒有新的更新。' : '沒有符合的紀錄。'}</p>
              ) : (
                <ul className="space-y-2">
                  {shown.map((entry) => (
                    <li key={entry.id} className="rounded-md border border-border/60">
                      <button
                        type="button"
                        onClick={() => toggleExpanded(entry.id)}
                        aria-expanded={expanded.has(entry.id)}
                        disabled={!entry.detail}
                        className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left outline-none hover:bg-muted/50 focus-visible:ring-1 focus-visible:ring-ring disabled:hover:bg-transparent"
                      >
                        <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', dotOf(entry.level))} />
                        <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                          {entry.title}
                          {isNew(entry) && (
                            <span className="ml-1.5 rounded bg-primary/15 px-1 align-middle text-[10px] font-semibold text-primary">新</span>
                          )}
                        </span>
                        {(() => {
                          const kind = kindOf(entry.kind);
                          return kind && (
                            <span className="mt-0.5 flex shrink-0 items-center gap-1 rounded border border-border px-1 text-[10px] leading-4 text-muted-foreground">
                              <kind.Icon className="h-3 w-3" />
                              {kind.label}
                            </span>
                          );
                        })()}
                        <span className="mt-0.5 shrink-0 text-[11px] tabular-nums text-muted-foreground">{entry.at}</span>
                        {entry.detail && (
                          <ChevronDown className={cn('mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform', expanded.has(entry.id) && 'rotate-180')} />
                        )}
                      </button>
                      {entry.detail && expanded.has(entry.id) && (() => {
                        // One line per change; several lines read as a list (a merged feature).
                        const lines = entry.detail.split('\n').map((line) => line.trim()).filter(Boolean);
                        return lines.length > 1 ? (
                          <ul className="mb-2 ml-7 mr-3 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                            {lines.map((line) => <li key={line}>{line}</li>)}
                          </ul>
                        ) : (
                          <p className="mb-2 ml-7 mr-3 text-xs text-muted-foreground">{lines[0]}</p>
                        );
                      })()}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
