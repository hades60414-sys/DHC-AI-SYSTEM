// 繁中回覆守門（使用者 2026-10-24 要求，10-27 補強）：
// - UserPromptSubmit：每回合提醒一次「含進度句一律繁中」。
// - PostToolUse：工具之間的進度句若是英文，立刻提醒模型改回中文（10-27 漏網的就是這種，Stop 只看最後一則）。
// - Stop：最後一則回覆主體是英文就擋下要求重寫；重寫那次（stop_hook_active）放行，不會無限迴圈。
// 程式碼區塊、行內程式碼、網址、路徑、去識別代號不算英文。
const fs = require('fs');
const os = require('os');
const path = require('path');

// 只讀檔尾，避免 1M 長對話每次工具呼叫都讀整個檔
function tailRows(file, bytes = 1024 * 1024) {
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  const len = Math.min(size, bytes);
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, size - len);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n');
  if (len < size) lines.shift(); // 第一行可能被切半
  const rows = [];
  for (const l of lines) { try { rows.push(JSON.parse(l)); } catch {} }
  return rows;
}

// 本回合（最後一則真正的使用者訊息之後）主對話的文字段落，由舊到新
function turnTexts(file) {
  const rows = tailRows(file);
  const out = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.isSidechain) continue;
    const content = row.message && row.message.content;
    if (row.type === 'user') {
      // 工具結果也是 user 列；碰到真正的使用者訊息才停
      if (typeof content === 'string' || (Array.isArray(content) && content.some((c) => c.type === 'text'))) break;
      continue;
    }
    if (row.type !== 'assistant' || !Array.isArray(content)) continue;
    const t = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (t.trim()) out.unshift({ id: row.uuid, text: t });
  }
  return out;
}

function mostlyEnglish(text, minLatin) {
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[A-Za-z]:[\/]\S*/g, ' ')
    .replace(/\bDEID_[A-Z]+_\d+\b/g, ' ');
  const cjk = (prose.match(/[㐀-鿿]/g) || []).length;
  const latin = (prose.match(/[A-Za-z]/g) || []).length;
  return latin >= minLatin && latin > cjk * 2;
}

const out = (o) => process.stdout.write(JSON.stringify(o));

let input = '';
process.stdin.on('data', (c) => (input += c)).on('end', () => {
  try {
    const e = JSON.parse(input);
    const ev = e.hook_event_name;

    if (ev === 'UserPromptSubmit') {
      return out({ hookSpecificOutput: { hookEventName: ev, additionalContext:
        '提醒：這回合所有給使用者看的文字（含工具之間的進度句、等待時的一句話、最後總結）一律繁體中文；指令、路徑、程式碼保留原文。' } });
    }

    if (!e.transcript_path) return;

    if (ev === 'PostToolUse') {
      const stateFile = path.join(os.tmpdir(), `zh-guard-${e.session_id || 'x'}.json`);
      let warned = [];
      try { warned = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
      const bad = turnTexts(e.transcript_path).filter((t) => t.id && !warned.includes(t.id) && mostlyEnglish(t.text, 15));
      if (!bad.length) return;
      fs.writeFileSync(stateFile, JSON.stringify(warned.concat(bad.map((t) => t.id)).slice(-200)));
      return out({ hookSpecificOutput: { hookEventName: ev, additionalContext:
        `剛才給使用者看的進度句是英文（「${bad[bad.length - 1].text.slice(0, 60)}…」）。使用者要求一律繁體中文：接下來每一句進度、說明、總結都改用繁體中文，不用回頭道歉或解釋。` } });
    }

    if (ev === 'Stop' || !ev) {
      if (e.stop_hook_active) return;
      const texts = turnTexts(e.transcript_path);
      const text = typeof e.last_assistant_message === 'string' ? e.last_assistant_message : (texts.length ? texts[texts.length - 1].text : '');
      if (!text || !mostlyEnglish(text, 40)) return;
      return out({ decision: 'block', reason:
        '上一則回覆主體是英文。使用者要求一律用繁體中文：請把同一則內容改用繁體中文完整重寫一次再結束（指令、路徑、程式碼保留原文），不要說明這次重寫。' });
    }
  } catch {}
});
