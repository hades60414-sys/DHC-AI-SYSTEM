const assert = require('node:assert');
const { ruleFires, REPEATS } = require('./assistant-nudge.cjs');
const day = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return { y, m, d, day: t.getUTCDay(), date: t.toISOString().slice(0, 10) }; };
assert.equal(ruleFires({ type: 'weekdays' }, day(2026, 10, 22)), true, '週四');
assert.equal(ruleFires({ type: 'weekdays' }, day(2026, 10, 24)), false, '週六不提醒');
assert.equal(ruleFires({ type: 'lastWeekday' }, day(2026, 10, 30)), true, '10/30 是 10 月最後平日');
assert.equal(ruleFires({ type: 'lastWeekday' }, day(2026, 10, 29)), false);
assert.equal(ruleFires({ type: 'lastWeekday' }, day(2026, 1, 30)), true, '1/31 是週六 → 1/30');
assert.equal(ruleFires({ type: 'monthDays', days: [1, 2] }, day(2026, 12, 1)), true);
assert.equal(ruleFires({ type: 'beforeMonthDay', day: 21, lead: 2 }, day(2026, 10, 19)), true);
assert.equal(ruleFires({ type: 'beforeMonthDay', day: 21, lead: 2 }, day(2026, 10, 22)), false);
assert.equal(ruleFires({ type: 'weekly', day: 4 }, day(2026, 10, 22)), true);
const kind = (t) => REPEATS.find(([, re]) => re.test(t))?.[0];
assert.equal(kind('訊息 207，層級 16，狀態 1'), '貼 SQL 錯誤或結果');
assert.equal(kind('幫我湊數 目標 1234'), '湊數對帳');
assert.equal(kind('今天天氣不錯'), undefined);
const { roleOf, pickAsks, parseClaim, applyClaims } = require('./assistant-nudge.cjs');
const P = 'p1', Q = 'p2';
// 未確認不推播：只有 who 算負責人；declined 蓋過 who；舊格式缺欄位不 throw
assert.equal(roleOf({ title: 'x' }, P), null, '缺 who 不 throw');
assert.equal(roleOf({ who: P }, P), 'who', 'who 是字串也認');
assert.equal(roleOf({ who: [P], declined: [P] }, P), 'declined', '否認優先');
assert.equal(roleOf({ ask: [P] }, P), 'ask', '候選不是負責人');
// 問句：要有 id、一次最多 3 件、最多問 2 次、隔 7 天
const items = ['a', 'b', 'c', 'd'].map((id) => ({ id, title: id, ask: [P] })).concat([{ title: 'noid', ask: [P] }, { id: 'e', title: 'e', declined: [P], ask: [P] }]);
assert.deepEqual(pickAsks(items, P, {}, '2026-10-28').map((x) => x.id), ['a', 'b', 'c'], '最多 3 件、沒 id 和已否認的不問');
assert.deepEqual(pickAsks(items, P, { 'p1|a': { n: 1, last: '2026-10-25' } }, '2026-10-28').map((x) => x.id), ['b', 'c', 'd'], '7 天內不重問');
assert.deepEqual(pickAsks(items, P, { 'p1|a': { n: 1, last: '2026-10-20' } }, '2026-10-28').map((x) => x.id)[0], 'a', '第 8 天再問');
assert.equal(pickAsks(items, P, { 'p1|a': { n: 2, last: '2026-01-01' } }, '2026-10-28').some((x) => x.id === 'a'), false, '問滿 2 次就停');
assert.equal(pickAsks(items, Q, {}, '2026-10-28').length, 0, '不是候選不問');
// 回答解析
assert.deepEqual(parseClaim('是 A，不是 b', ['x', 'y']), { x: 'yes', y: 'no' });
assert.deepEqual(parseClaim('是A、C', ['x', 'y', 'z']), { x: 'yes', z: 'yes' });
assert.deepEqual(parseClaim('都不是', ['x', 'y']), { x: 'no', y: 'no' });
assert.deepEqual(parseClaim('不是我的，是同事G的', ['x']), { x: 'no' }, '一件時直接說不是');
assert.deepEqual(parseClaim('對', ['x']), { x: 'yes' });
assert.deepEqual(parseClaim('對', ['x', 'y']), {}, '多件時沒字母不猜');
assert.deepEqual(parseClaim('是BSC的那個', ['x', 'y']), {}, 'BSC 不當成 B');
// 寫進日曆：是→who、不是→declined，重跑不重記
const cal = { items: [{ id: 'x', ask: [P] }, { id: 'y', ask: [P], who: [Q] }] };
assert.equal(applyClaims(cal, P, { x: 'yes', y: 'no' }, 't').length, 2);
assert.deepEqual([cal.items[0].who, cal.items[0].ask], [[P], []]);
assert.deepEqual([cal.items[1].declined, cal.items[1].who], [[P], [Q]], '否認不影響別人');
assert.equal(applyClaims(cal, P, { x: 'yes', y: 'no' }, 't').length, 0, '同樣答案重跑不重記');
assert.equal(cal.items[0].log.length, 1);
assert.equal(applyClaims(cal, P, { y: 'yes' }, 't').length, 1, '改口可以');
assert.deepEqual([cal.items[1].who, cal.items[1].declined], [[Q, P], []]);
// 日常對話不算確認（10-27 verifier 反例）
for (const t of ['我的報表跑不出來', '好像有錯', '對了，順便問一下', '嗯…先等等', '沒有啦我只是問問', '好']) assert.deepEqual(parseClaim(t, ['x']), {}, t);
for (const t of ['路徑是C:/data', '那支是A股的嗎', '都是同一個錯誤']) assert.deepEqual(parseClaim(t, ['x', 'y', 'z']), {}, t);
assert.deepEqual(parseClaim('是', ['x'], false), {}, '不是問句後第一則，單字是不算');
assert.deepEqual(parseClaim('是 A', ['x'], false), { x: 'yes' }, '有字母任何時候都算');
console.log('assistant-nudge 測試全部通過');
