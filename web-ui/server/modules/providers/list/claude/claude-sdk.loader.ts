/**
 * ASTRA-012：Claude Agent SDK 只在個人模式真的呼叫 Claude 時才載入（動態 import）。
 * 企業模式不掛 legacy provider 路由，因此伺服器啟動與執行期都不會載入 SDK；企業 image 可安全排除這個套件
 * （其再散布條件尚未取得權利人核准）。缺套件時丟出可辨識的錯誤，而不是讓整個伺服器在 import 階段崩潰。
 */
type ClaudeAgentSdk = typeof import('@anthropic-ai/claude-agent-sdk');

let loaded: Promise<ClaudeAgentSdk> | null = null;

export function loadClaudeAgentSdk(): Promise<ClaudeAgentSdk> {
  loaded ??= import('@anthropic-ai/claude-agent-sdk').catch(error => {
    loaded = null;
    throw Object.assign(new Error('CLAUDE_AGENT_SDK_UNAVAILABLE'), { cause: error });
  });
  return loaded;
}
