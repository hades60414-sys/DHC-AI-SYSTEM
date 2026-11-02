// offload-scan.cjs — how much work went to models other than the shared Claude subscription, for the sidebar split meter.
// Counted in fresh tokens (new input + cache writes + output; cache reads left out, since a long Claude context re-read
// every turn would otherwise drown everything else). Sources, all local and read-only:
//   Codex   ~/.codex/sessions/**/rollout-*.jsonl   (Codex app / web UI Codex sessions: total_token_usage deltas)
//           offload-usage.jsonl                    (codex-bridge subagent runs; they are --ephemeral, so not in sessions)
//   Gemini  ~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript_full.jsonl   (agy steps)
// Small enough (< 10 MB) to re-read every run. Used by usage-scan.cjs; `node offload-scan.cjs` prints this week.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');

const HOME = os.homedir();
const CODEX_DIR = path.join(HOME, '.codex', 'sessions');
const BRIDGE_LOG = path.join(__dirname, 'offload-usage.jsonl');
const AGY_DIR = path.join(HOME, '.gemini', 'antigravity-cli', 'brain');

function* walk(d, test) {
  let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p, test);
    else if (test(p)) yield p;
  }
}
const recent = (p, since) => { try { return fs.statSync(p).mtimeMs >= since; } catch { return false; } };
const lines = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n'); } catch { return []; } };
const json = (l) => { try { return l ? JSON.parse(l) : null; } catch { return null; } };

// → { Codex: { tokens, calls, models: {} }, Gemini: {...} } for calls with lo <= time < hi.
function offload(lo, hi) {
  const out = {};
  const add = (vendor, t, tokens, model) => {
    if (!(t >= lo && t < hi) || !(tokens > 0)) return;
    const v = out[vendor] || (out[vendor] = { tokens: 0, calls: 0, models: {} });
    v.tokens += tokens; v.calls += 1;
    v.models[model || '?'] = (v.models[model || '?'] || 0) + tokens;
  };
  // A session file can be touched long after it started (resume), so filter by mtime only to skip old ones.
  for (const f of walk(CODEX_DIR, (p) => p.endsWith('.jsonl'))) {
    if (!recent(f, lo)) continue;
    let model = null, prev = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
    for (const l of lines(f)) {
      const j = json(l); if (!j || !j.payload) continue;
      if (j.type === 'turn_context' && j.payload.model) model = j.payload.model;
      const u = j.payload.type === 'token_count' && j.payload.info && j.payload.info.total_token_usage;
      if (!u) continue;
      // Running totals, repeated as-is on duplicate events: count only what grew since the last one.
      const fresh = (u.input_tokens - prev.input_tokens) - (u.cached_input_tokens - prev.cached_input_tokens) + (u.output_tokens - prev.output_tokens);
      if (fresh > 0) add('Codex', Date.parse(j.timestamp), fresh, model);
      prev = u;
    }
  }
  for (const l of lines(BRIDGE_LOG)) {
    const j = json(l); if (!j) continue;
    add('Codex', Date.parse(j.t), (j.input || 0) - (j.cached || 0) + (j.output || 0), j.model);
  }
  for (const f of walk(AGY_DIR, (p) => p.endsWith(path.join('logs', 'transcript_full.jsonl')))) {
    if (!recent(f, lo)) continue;
    for (const l of lines(f)) {
      const j = json(l); if (!j || j.input_tokens == null) continue;
      add('Gemini', Date.parse(j.created_at), (j.input_tokens || 0) + (j.output_tokens || 0), j.model || 'agy');
    }
  }
  return out;
}

module.exports = { offload };
if (require.main === module) {
  const now = Date.now();
  console.log(JSON.stringify(offload(now - 7 * 86400e3, now), null, 1));
}
