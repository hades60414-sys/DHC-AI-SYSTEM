// Stop hook：最後一則回覆主體是英文就擋下，請模型改用繁體中文重寫（使用者 2026-10-24 要求）。
// 只看這一回合最後的文字回覆；程式碼區塊、行內程式碼、網址、路徑不算。重寫後的那次（stop_hook_active）一律放行，不會無限迴圈。
const fs = require('fs');

function lastReply(transcriptPath) {
  const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n').slice(-400);
  const texts = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let row;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    if (row.isSidechain) continue;
    const content = row.message && row.message.content;
    if (row.type === 'user') {
      // 工具結果也是 user 列；碰到真正的使用者訊息才停
      if (typeof content === 'string' || (Array.isArray(content) && content.some((c) => c.type === 'text'))) break;
      continue;
    }
    if (row.type !== 'assistant' || !Array.isArray(content)) continue;
    const t = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (t.trim()) { texts.unshift(t); break; }
  }
  return texts.join('\n');
}

function mostlyEnglish(text) {
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[A-Za-z]:[\\/]\S*/g, ' ')
    .replace(/\bDEID_[A-Z]+_\d+\b/g, ' ');
  const cjk = (prose.match(/[㐀-鿿]/g) || []).length;
  const latin = (prose.match(/[A-Za-z]/g) || []).length;
  return latin > 80 && latin > cjk * 2;
}

let input = '';
process.stdin.on('data', (c) => (input += c)).on('end', () => {
  try {
    const e = JSON.parse(input);
    if (e.stop_hook_active || !e.transcript_path) return;
    const text = typeof e.last_assistant_message === 'string' ? e.last_assistant_message : lastReply(e.transcript_path);
    if (!text || !mostlyEnglish(text)) return;
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: '上一則回覆主體是英文。使用者要求一律用繁體中文：請把同一則內容改用繁體中文完整重寫一次再結束（指令、路徑、程式碼保留原文），不要說明這次重寫。',
    }));
  } catch {}
});
