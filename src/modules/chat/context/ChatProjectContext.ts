import { createContext, useContext } from 'react';

/** 目前聊天所屬專案的 id（ChatInterface 提供），讓訊息內的本機圖片能走專案檔案端點讀取。沒有專案時是 null。 */
export const ChatProjectContext = createContext<string | null>(null);

export function useChatProjectId(): string | null {
  return useContext(ChatProjectContext);
}
