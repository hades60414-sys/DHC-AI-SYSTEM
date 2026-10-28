import { useSyncExternalStore } from 'react';

/**
 * DHC CLI A3: "quiet" transcript view. Quiet shows what a reader wants — your prompts, the final
 * reply of each turn, day dividers, compaction rows, errors — and folds every tool call and
 * in-between progress note of a turn into one line that expands on click. Full is the normal view.
 * Per browser, because it is a reading preference. Quiet is the default (2026-10-13); only an explicit
 * switch back to full is remembered as full.
 */
const STORAGE_KEY = 'dhc.transcriptQuiet';

let quiet = readQuiet();
const listeners = new Set<() => void>();

function readQuiet(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function setQuiet(next: boolean): void {
  quiet = next;
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Storage blocked: the toggle still works for this page load.
  }
  listeners.forEach((listener) => listener());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = () => quiet;

export function toggleTranscriptQuiet(): void {
  setQuiet(!quiet);
}

export function useTranscriptQuiet(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
