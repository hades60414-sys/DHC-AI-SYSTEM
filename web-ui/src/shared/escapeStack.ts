import { useEffect, useRef } from 'react';

/**
 * Esc closes only the topmost open layer (the one that opened last). One window listener serves the whole stack;
 * Esc while an input method is composing is left to the input method.
 * Open order is taken at render time: effects run child-first, so layers mounted together would otherwise put the outer one on top.
 */
type Layer = { current: () => void; order: number };
const stack: Layer[] = [];
let seq = 0;

const onKeyDown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  event.preventDefault();
  top.current();
};

export function useEscapeClose(onClose: () => void, active = true) {
  const layer = useRef<Layer>({ current: onClose, order: 0 });
  const wasActive = useRef(false);
  layer.current.current = onClose;
  if (active && !wasActive.current) layer.current.order = ++seq;
  wasActive.current = active;
  useEffect(() => {
    if (!active) return undefined;
    const entry = layer.current;
    if (stack.length === 0) window.addEventListener('keydown', onKeyDown);
    const at = stack.findIndex((other) => other.order > entry.order);
    stack.splice(at === -1 ? stack.length : at, 0, entry);
    return () => {
      stack.splice(stack.indexOf(entry), 1);
      if (stack.length === 0) window.removeEventListener('keydown', onKeyDown);
    };
  }, [active]);
}
