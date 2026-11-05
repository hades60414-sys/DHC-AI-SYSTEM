import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, ChevronUp, Loader2, Mic, Phone } from 'lucide-react';

import { useDeviceSettings } from '@/shared/hooks/useDeviceSettings';
import { PromptInputButton } from '@/modules/chat/composer/PromptInput';
import type { VoiceInputState } from '@/shared/types';
import type { VoiceMode } from '@/modules/chat/hooks/voiceMode';

type Props = {
  state: VoiceInputState;
  onToggle: () => void;
  errorMsg?: string | null;
  /** 雲端辨識進行中的即時文字 */
  interim?: string;
  /** 目前的辨識方式；按麥克風就用它開始錄音 */
  mode: VoiceMode;
  /** 瀏覽器支援雲端（Web Speech）才給：換辨識方式並立刻開始錄音 */
  onStartWith?: (m: VoiceMode) => void;
  /** 有語音通話才給「語音對話」 */
  onCall?: () => void;
};

const MODE_LABEL: Record<VoiceMode, string> = { cloud: '雲端', local: '本機' };
const MODE_HINT: Record<VoiceMode, string> = { cloud: '較快，語音送 Google', local: '不外傳，稍慢' };

// Rendered by chat's ChatComposer next to the send button.
// Split button: the mic itself starts / stops dictation right away with the remembered engine;
// the small ⌃ beside it (or right-click / long-press on the mic) opens the engine + 語音對話 menu.
// Recording state and the stop-and-send action are owned by the composer so Send can drive them too.
export default function VoiceInputButton({ state, onToggle, errorMsg, interim, mode, onStartWith, onCall }: Props) {
  const { t } = useTranslation('chat');
  // 手機沒有 hover，浮動提示會蓋住紅色錯誤泡泡，所以手機不給 tooltip
  const { isMobile } = useDeviceSettings({ trackPWA: false });
  // 輸入框外層會裁切，選單掛到 body、照按鈕位置往上開；值是按鈕的 rect
  const [menuAt, setMenuAt] = useState<DOMRect | null>(null);
  const menuOpen = menuAt !== null;
  const rootRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  // 窄螢幕上置中的選單會超出畫面：量過之後把它平移回畫面內（左右各留 8px）
  const [menuShift, setMenuShift] = useState(0);
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menuAt || !el) {
      setMenuShift(0);
      return;
    }
    // From the button's centre and the menu's width, so the result does not depend on the shift already applied.
    const half = el.getBoundingClientRect().width / 2;
    const center = menuAt.left + menuAt.width / 2;
    const naturalLeft = center - half;
    const naturalRight = center + half;
    const margin = 8;
    const shift = naturalLeft < margin
      ? margin - naturalLeft
      : naturalRight > window.innerWidth - margin ? window.innerWidth - margin - naturalRight : 0;
    if (shift !== menuShift) setMenuShift(shift);
  });
  const setMenuOpen = (open: boolean) => setMenuAt(open ? rootRef.current?.getBoundingClientRect() ?? null : null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!rootRef.current?.contains(t) && !menuRef.current?.contains(t)) setMenuAt(null);
    };
    const close = () => setMenuAt(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuAt(null);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('resize', close);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const icon =
    state === 'recording' ? (
      <Mic className="animate-pulse text-red-500" />
    ) : state === 'transcribing' ? (
      <Loader2 className="animate-spin" />
    ) : (
      <Mic />
    );

  const idle = state === 'idle';
  const hasMenu = idle && Boolean(onStartWith || onCall);
  const label = state === 'recording' ? t('voice.stopRecording') : t('voice.input');
  const tip = idle ? `${label}（${MODE_LABEL[mode]}辨識）` : label;

  return (
    <span ref={rootRef} className="relative inline-flex items-center">
      {errorMsg && (
        <span className="absolute bottom-full left-0 z-50 mb-1 w-max max-w-[80vw] rounded bg-red-600 px-2 py-1 text-xs text-white shadow-lg">
          {errorMsg}
        </span>
      )}
      {isMobile && !errorMsg && !interim && state !== 'idle' && (
        <span data-testid="voice-status" className="absolute bottom-full left-0 z-50 mb-1 w-max max-w-[80vw] rounded bg-foreground px-2 py-1 text-xs text-background shadow-lg">
          {state === 'recording' ? '錄音中，再按一次結束' : '辨識中…（約 10–20 秒）'}
        </span>
      )}
      {interim && !errorMsg && (
        <span className="absolute bottom-full left-1/2 mb-1 max-w-[70vw] -translate-x-1/2 rounded bg-foreground px-2 py-1 text-xs text-background shadow-lg">
          {interim}
        </span>
      )}
      {menuAt && hasMenu && !errorMsg && createPortal(
        <span
          ref={menuRef}
          role="menu"
          data-testid="voice-menu"
          style={{ bottom: window.innerHeight - menuAt.top + 4, left: menuAt.left + menuAt.width / 2 + menuShift, maxWidth: 'calc(100vw - 16px)' }}
          className="fixed z-[1000] flex w-max -translate-x-1/2 flex-col overflow-hidden rounded-md border bg-popover py-1 text-sm text-popover-foreground shadow-lg"
        >
          {onStartWith && (
            <>
              <span className="px-3 pb-1 pt-0.5 text-xs text-muted-foreground">選辨識方式並開始說話</span>
              {(['cloud', 'local'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="menuitemradio"
                  aria-checked={mode === m}
                  data-testid={`voice-menu-${m}`}
                  onClick={() => {
                    setMenuOpen(false);
                    onStartWith(m);
                  }}
                  className="flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted"
                >
                  <Check className={`h-3.5 w-3.5 shrink-0 ${mode === m ? '' : 'invisible'}`} />
                  <span>{MODE_LABEL[m]}辨識</span>
                  <span className="text-xs text-muted-foreground">{MODE_HINT[m]}</span>
                </button>
              ))}
            </>
          )}
          {onStartWith && onCall && <span className="my-1 border-t" />}
          {onCall && (
            <button
              type="button"
              role="menuitem"
              data-testid="voice-menu-call"
              onClick={() => {
                setMenuOpen(false);
                onCall();
              }}
              className="flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted"
            >
              <Phone className="h-3.5 w-3.5 shrink-0" />
              <span>語音對話</span>
              <span className="text-xs text-muted-foreground">免按鍵，講完自動送出</span>
            </button>
          )}
        </span>,
        document.body,
      )}
      <PromptInputButton
        tooltip={isMobile || menuOpen ? undefined : { content: tip }}
        aria-label={label}
        data-tutorial-tip="語音輸入：按一下開始說話、再按一下結束，文字填進輸入框；旁邊的 ⌃ 換辨識方式或開語音對話"
        onClick={(e: { preventDefault: () => void }) => {
          e.preventDefault();
          setMenuOpen(false);
          onToggle();
        }}
        onContextMenu={(e: { preventDefault: () => void }) => {
          if (!hasMenu) return;
          e.preventDefault();
          setMenuOpen(!menuOpen);
        }}
      >
        {icon}
      </PromptInputButton>
      {hasMenu && (
        <button
          type="button"
          aria-label="語音選項"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-testid="voice-more"
          onClick={(e) => {
            e.preventDefault();
            setMenuOpen(!menuOpen);
          }}
          className={`-ml-1 flex !min-h-0 !min-w-0 items-center ${isMobile ? '!h-10 !w-7' : '!h-8 !w-4'} justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground ${menuOpen ? 'bg-muted text-foreground' : ''}`}
        >
          <ChevronUp className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
