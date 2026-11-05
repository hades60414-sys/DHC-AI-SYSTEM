import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * Phone-width right-edge rail: the 待辦 / 自選功能 / 聊天室 / 快速設定 handles carry `data-rail-item` and index.css
 * hides them under 768px (10/25 起手機不再顯示把手，改由頂端漢堡選單 MobileRailToggle 叫出對應面板，見下方 requestRailOpen)。
 * Handles with a count (待辦, 聊天室) report it here so the hamburger can show the sum.
 */
const counts = new Map<string, number>();
const listeners = new Set<() => void>();
let total = 0;

const emit = () => {
  total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0);
  listeners.forEach((listener) => listener());
};

/** Returns a cleanup so an unmounted handle stops counting. */
export function setRailCount(key: string, count: number): () => void {
  counts.set(key, count);
  emit();
  return () => {
    counts.delete(key);
    emit();
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useRailTotal = () => useSyncExternalStore(subscribe, () => total, () => 0);

/** 單一把手的數字（手機頂端聊天室鈕自己顯示聊天室未讀）。 */
export const useRailCount = (key: string) => useSyncExternalStore(subscribe, () => counts.get(key) ?? 0, () => 0);

/**
 * 手機頂端選單（MobileRailToggle）叫右緣把手打開對應面板：把手各自管自己的開關狀態，
 * 所以用事件通知，不去點被藏起來的把手。聊天室不需要（直接呼叫 openChatPanel）。
 */
export type RailTarget = 'todo' | 'library' | 'settings';
export const RAIL_OPEN_EVENT = 'dhc-rail-open';

export const requestRailOpen = (target: RailTarget) => {
  window.dispatchEvent(new CustomEvent<RailTarget>(RAIL_OPEN_EVENT, { detail: target }));
};

/** 面板元件掛這個，收到對應事件就執行 handler。 */
export function useRailOpenRequest(target: RailTarget, handler: () => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const onRequest = (event: Event) => {
      if ((event as CustomEvent<RailTarget>).detail === target) handlerRef.current();
    };
    window.addEventListener(RAIL_OPEN_EVENT, onRequest);
    return () => window.removeEventListener(RAIL_OPEN_EVENT, onRequest);
  }, [target]);
}
