import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { MonitorUp, Square } from 'lucide-react';

import DeskLaser from '@/modules/command-mode/DeskLaser';
import { commandModeStore } from '@/modules/command-mode/store';
import { useCommandModeDesktop } from '@/modules/command-mode/useCommandModeDesktop';

declare global {
  interface Window {
    __dhcCommandModeDesktop?: { snapshot: () => unknown };
  }
}

type Props = {
  /** 目前專案的路徑（selectedProject.fullPath）；手機與電腦用它對到同一間房。 */
  projectKey: string | null;
};

/**
 * 掛在 WorkspaceHeader。手機、電腦都會掛：手機用它告訴指揮模式目前在哪個專案；
 * 電腦在「別台裝置正在這個專案通話」時顯示「指揮模式」按鈕，開著時頂端一直有橫幅和停止鈕。
 */
export default function CommandModeControl({ projectKey }: Props) {
  const desk = useCommandModeDesktop(projectKey);

  useEffect(() => {
    commandModeStore.setProjectKey(projectKey);
  }, [projectKey]);

  useEffect(() => {
    window.__dhcCommandModeDesktop = { snapshot: () => ({ phoneLive: desk.phoneLive, phase: desk.phase, framesSent: desk.framesSent, error: desk.error }) };
  }, [desk.phoneLive, desk.phase, desk.framesSent, desk.error]);

  const showButton = desk.supported && (desk.phoneLive || desk.phase !== 'idle');
  if (!showButton) return null;

  const active = desk.phase !== 'idle';
  return (
    <>
      <button
        type="button"
        data-testid="command-mode-button"
        onClick={() => (active ? desk.stop() : void desk.start())}
        title={desk.error ?? '手機通話中：分享這台電腦的整個螢幕給手機看，手機可以在上面圈點'}
        className={`inline-flex flex-shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium ${active ? 'bg-red-600 text-white hover:bg-red-700' : 'border border-amber-500 text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-900/30'}`}
      >
        {active ? <Square className="h-3.5 w-3.5" /> : <MonitorUp className="h-3.5 w-3.5" />}
        {desk.phase === 'picking' ? '選擇螢幕中' : active ? '停止指揮模式' : '指揮模式'}
      </button>
      {desk.phase === 'sharing' && <DeskLaser onMark={desk.addMark} />}
      {desk.phase === 'sharing' && createPortal(
        // 整個視窗一圈紅框＋標頭下方一顆小標籤；兩者都不擋點擊（只有停止鈕接事件），頁面照常操作。
        <>
          <div aria-hidden className="pointer-events-none fixed inset-0 z-[10000] border-[3px] border-red-600" />
          <div
            role="status"
            data-testid="command-mode-banner"
            className="pointer-events-none fixed left-1/2 top-14 z-[10000] flex max-w-[calc(100vw-1rem)] -translate-x-1/2 items-center gap-2 rounded-full bg-red-600 py-1 pl-3 pr-1 text-xs font-semibold text-white shadow-lg"
          >
            <span className="inline-block h-2 w-2 flex-shrink-0 animate-pulse rounded-full bg-white" aria-hidden />
            <span className="truncate">指揮模式中：手機看得到整個螢幕．按住右鍵可畫雷射筆（只限 DHC CLI 視窗內，其他程式畫不到）</span>
            <button
              type="button"
              onClick={desk.stop}
              className="pointer-events-auto flex-shrink-0 rounded-full bg-white px-2 py-0.5 font-bold text-red-700 hover:bg-red-50"
            >
              停止
            </button>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
