import { useCallback, useContext } from 'react';

import WebSocketContext from '@/shared/context/WebSocketContext';
import type { ServerEvent } from '@/shared/types';
import { readActiveSettingsProfileId } from '@/shared/userSettings';

const NOOP_SEND = () => undefined;
const NOOP_SUBSCRIBE = (_listener: (event: ServerEvent) => void) => () => undefined;

/** 聊天 websocket；外層沒有 WebSocketProvider（例如單元測試只掛面板）時指揮模式就不動作。 */
export function useCommandSocket() {
  const context = useContext(WebSocketContext);
  const contextSend = context?.sendMessage;
  // 每則指揮模式訊息都帶這台裝置的設定檔 id；伺服器只在同一個人的裝置之間轉送畫面。
  const sendMessage = useCallback((message: object) => {
    contextSend?.({ ...message, profileId: readActiveSettingsProfileId() || null });
  }, [contextSend]);
  return {
    sendMessage: contextSend ? sendMessage : NOOP_SEND,
    subscribe: context?.subscribe ?? NOOP_SUBSCRIBE,
    isConnected: context?.isConnected ?? false,
  };
}
