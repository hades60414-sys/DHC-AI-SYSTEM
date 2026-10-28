import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, TouchEvent as ReactTouchEvent } from 'react';

import type { QuickSettingsHandleStyle } from '@/shared/types';

const HANDLE_POSITION_STORAGE_KEY = 'quickSettingsHandlePosition';

const HANDLE_POSITION_MIN = 10;
const HANDLE_POSITION_MAX = 90;
// DHC：桌面預設放到最低（跟輸入框同一排），不擋訊息區右緣的對話跳轉拉桿。手機的位置是從底部算，
// 右緣不是拉桿就是輸入框，維持原本的中間。
const DEFAULT_DESKTOP_POSITION = HANDLE_POSITION_MAX;
const DEFAULT_MOBILE_POSITION = 50;
// 舊版每次載入都把預設值 50 存起來；存的剛好是 50 就當作沒拖過，新預設才吃得到。
const LEGACY_SAVED_DEFAULT = 50;
const DRAG_THRESHOLD_PX = 5;

type UseQuickSettingsDragProps = {
  isMobile: boolean;
};

type StartDragEvent = ReactMouseEvent<HTMLButtonElement> | ReactTouchEvent<HTMLButtonElement>;
type MoveDragEvent = MouseEvent | TouchEvent;
type EventWithClientY = StartDragEvent | MoveDragEvent;

const clampPosition = (value: number): number => (
  Math.max(HANDLE_POSITION_MIN, Math.min(HANDLE_POSITION_MAX, value))
);

/** The position the user dragged to on this browser, or null when they never moved it. */
const readSavedPosition = (): number | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const saved = localStorage.getItem(HANDLE_POSITION_STORAGE_KEY);
  if (!saved) {
    return null;
  }

  try {
    const parsed = JSON.parse(saved) as { y?: unknown };
    if (typeof parsed.y === 'number' && Number.isFinite(parsed.y) && parsed.y !== LEGACY_SAVED_DEFAULT) {
      return clampPosition(parsed.y);
    }
  } catch {
    localStorage.removeItem(HANDLE_POSITION_STORAGE_KEY);
  }

  return null;
};

const isTouchEvent = (event: { type: string }): boolean => event.type.includes('touch');

const getClientY = (event: EventWithClientY): number | null => {
  if ('touches' in event) {
    return event.touches[0]?.clientY ?? null;
  }

  return 'clientY' in event && typeof event.clientY === 'number'
    ? event.clientY
    : null;
};

export function useQuickSettingsDrag({ isMobile }: UseQuickSettingsDragProps) {
  const [savedPosition, setSavedPosition] = useState<number | null>(readSavedPosition);
  const handlePosition = savedPosition ?? (isMobile ? DEFAULT_MOBILE_POSITION : DEFAULT_DESKTOP_POSITION);
  const [isPointerDown, setIsPointerDown] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const dragStartYRef = useRef<number | null>(null);
  const dragStartPositionRef = useRef(handlePosition);
  const didDragRef = useRef(false);
  const suppressNextClickRef = useRef(false);
  const bodyStylesAppliedRef = useRef(false);

  const clearBodyDragStyles = useCallback(() => {
    if (!bodyStylesAppliedRef.current) {
      return;
    }

    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.body.style.overflow = '';
    document.body.style.position = '';
    document.body.style.width = '';
    bodyStylesAppliedRef.current = false;
  }, []);

  const applyBodyDragStyles = useCallback((isTouchDragging: boolean) => {
    if (bodyStylesAppliedRef.current) {
      return;
    }

    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';

    // Touch drag should lock body scroll so the handle movement stays smooth.
    if (isTouchDragging) {
      document.body.style.overflow = 'hidden';
      document.body.style.position = 'fixed';
      document.body.style.width = '100%';
    }

    bodyStylesAppliedRef.current = true;
  }, []);

  const endDrag = useCallback(() => {
    if (!isPointerDown && dragStartYRef.current === null) {
      return;
    }

    suppressNextClickRef.current = didDragRef.current;
    didDragRef.current = false;
    dragStartYRef.current = null;
    setIsPointerDown(false);
    setIsDragging(false);
    clearBodyDragStyles();
  }, [clearBodyDragStyles, isPointerDown]);

  const handleMove = useCallback(
    (event: MoveDragEvent) => {
      if (!isPointerDown || dragStartYRef.current === null) {
        return;
      }

      const clientY = getClientY(event);
      if (clientY === null) {
        return;
      }

      const rawDelta = clientY - dragStartYRef.current;
      const movedPastThreshold = Math.abs(rawDelta) > DRAG_THRESHOLD_PX;

      if (!didDragRef.current && movedPastThreshold) {
        didDragRef.current = true;
        setIsDragging(true);
        applyBodyDragStyles(isTouchEvent(event));
      }

      if (!didDragRef.current) {
        return;
      }

      if (isTouchEvent(event)) {
        event.preventDefault();
      }

      const viewportHeight = Math.max(window.innerHeight, 1);
      const normalizedDelta = (rawDelta / viewportHeight) * 100;
      const positionDelta = isMobile ? -normalizedDelta : normalizedDelta;
      setSavedPosition(clampPosition(dragStartPositionRef.current + positionDelta));
    },
    [applyBodyDragStyles, isMobile, isPointerDown],
  );

  const startDrag = useCallback((event: StartDragEvent) => {
    event.stopPropagation();

    const clientY = getClientY(event);
    if (clientY === null) {
      return;
    }

    dragStartYRef.current = clientY;
    dragStartPositionRef.current = handlePosition;
    didDragRef.current = false;
    setIsDragging(false);
    setIsPointerDown(true);
  }, [handlePosition]);

  // Persist only a position the user dragged to, so a later default change still reaches untouched browsers.
  useEffect(() => {
    if (savedPosition === null) {
      return;
    }

    localStorage.setItem(
      HANDLE_POSITION_STORAGE_KEY,
      JSON.stringify({ y: savedPosition }),
    );
  }, [savedPosition]);

  useEffect(() => {
    if (!isPointerDown) {
      return undefined;
    }

    const handleMouseMove = (event: MouseEvent) => {
      handleMove(event);
    };
    const handleMouseUp = () => {
      endDrag();
    };
    const handleTouchMove = (event: TouchEvent) => {
      handleMove(event);
    };
    const handleTouchEnd = () => {
      endDrag();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [endDrag, handleMove, isPointerDown]);

  useEffect(() => (
    () => {
      clearBodyDragStyles();
    }
  ), [clearBodyDragStyles]);

  const consumeSuppressedClick = useCallback((): boolean => {
    if (!suppressNextClickRef.current) {
      return false;
    }

    suppressNextClickRef.current = false;
    return true;
  }, []);

  const handleStyle = useMemo<QuickSettingsHandleStyle>(() => {
    if (!isMobile || typeof window === 'undefined') {
      return {
        top: `${handlePosition}%`,
        transform: 'translateY(-50%)',
      };
    }

    return {
      bottom: `${(window.innerHeight * handlePosition) / 100}px`,
    };
  }, [handlePosition, isMobile]);

  return {
    isDragging,
    handleStyle,
    startDrag,
    consumeSuppressedClick,
  };
}
