// 從 Lasso patterns（已轉 JSON）產生本機規則檔：拿掉 JS 不支援的 (?i)、降噪、加中文與外洩規則。
// 用法：node build-patterns.cjs <lasso-patterns.json> <輸出路徑>
const fs = require('fs');
const [src, dst] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(src, 'utf8'));

// 在本機日常輸出（JSON、程式碼、對話紀錄）裡很常見的 medium 規則，降為 low：只記錄不警告。
const NOISY = [
  String.raw`\bact\s+as`, String.raw`"\s*(system|role`, String.raw`//\s*(ignore`,
  String.raw`\\u[0-9a-fA-F]{4}`, String.raw`\\x[0-9a-fA-F]{2}`, String.raw`0x[0-9a-fA-F]{2}`,
  String.raw`hex\s*(string`, String.raw`\b(what|list|show)`, String.raw`(two|dual|split`,
  String.raw`\burl\s*(encoded`, String.raw`(context|background|situation)`, String.raw`\bpriority\s*(level)`,
];
let low = 0;
for (const k in d) for (const p of d[k]) {
  if (p.severity === 'medium' && NOISY.some(s => p.pattern.includes(s))) { p.severity = 'low'; low++; }
  // 「no rules／without restrictions」在一般文件也常見（AGENTS.md 就有），高降中：要搭配別的跡象才警示
  if (p.reason === 'No-rules mode request') p.severity = 'medium';
}

d.chinesePatterns = [
  [String.raw`(忽略|無視|忽视|无视|不要理會|别管)(掉)?(之前|先前|以上|上面|前面|所有|全部)(的)?(所有)?(指令|指示|規則|规则|提示|設定|设定|要求)`, '中文：要求忽略先前指令', 'high'],
  [String.raw`(忘記|忘记|忘掉)(你|之前|先前|所有)(的)?(指令|指示|規則|规则|設定|设定|訓練|训练)`, '中文：要求忘記指令', 'high'],
  [String.raw`(新的|真正的|更新後的|更新后的)(系統|系统)(提示|提示詞|提示词|指令)`, '中文：偽造新系統提示', 'high'],
  [String.raw`(你現在是|你现在是|從現在起你是|从现在起你是|假裝你是|假装你是|扮演).{0,20}(不受|沒有|没有|無|无)(任何)?(限制|規則|规则|約束|约束)`, '中文：無限制角色扮演', 'high'],
  [String.raw`(給|给|致)\s*(AI|ai|助理|助手|代理|模型|Claude|ChatGPT|GPT)[^\n]{0,15}(的)?(指令|指示|訊息|消息)[:：]`, '中文：寫給 AI 的指令', 'medium'],
  [String.raw`(不要|別|别)(告訴|告诉|讓|让)(使用者|用戶|用户|人類|人类)(知道)?`, '中文：要求對使用者隱瞞', 'high'],
  [String.raw`(開發者|开发者|管理員|管理员)模式`, '中文：開發者／管理員模式', 'medium'],
].map(([pattern, reason, severity]) => ({ pattern, reason, severity }));

d.agentTargetingPatterns = [
  [String.raw`\b(if\s+you\s+are|attention|note\s+to|message\s+for)\s+(an?\s+)?(ai|llm|language\s+model|assistant|agent|claude|chatgpt)\b`, 'Content addressing AI agents directly', 'medium'],
  [String.raw`\b(do\s+not|don.t|never)\s+(tell|inform|mention|alert)\s+(this\s+to\s+)?(the\s+)?(user|human|operator)`, 'Asks to hide actions from user', 'high'],
  [String.raw`\b(send|post|upload|exfiltrate|forward|transmit)\b[^\n]{0,60}\b(api[_\s-]?keys?|tokens?|credentials?|passwords?|secrets?|\.env|ssh\s+keys?|cookies?)\b[^\n]{0,60}(https?://|webhook|to\s+(this|the\s+following)\s+(url|endpoint|address))`, 'Data exfiltration instruction', 'high'],
  [String.raw`!\[[^\]]*\]\(https?://[^)\s]*[?&][^)\s]*=\s*(\{|\$|<)`, 'Markdown image URL with templated query (exfil beacon)', 'high'],
  [String.raw`<\s*(\|?im_start\|?|system-reminder)\s*>`, 'Fake chat/system tag', 'medium'],
].map(([pattern, reason, severity]) => ({ pattern, reason, severity }));

for (const k in d) for (const p of d[k]) new RegExp(p.pattern, 'im'); // 編譯不過就讓腳本直接報錯
const out = {
  _source: 'Ported from lasso-security/claude-hooks (MIT, commit 8fbfd14, patterns.yaml). Inline (?i) removed for JS; noisy rules downgraded to low; chinesePatterns and agentTargetingPatterns added by TAS 2026-11-03.',
  ...d,
};
fs.writeFileSync(dst, JSON.stringify(out, null, 1));
console.log('downgraded', low, Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.length])));
