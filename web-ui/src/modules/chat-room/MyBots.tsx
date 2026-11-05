import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Copy, Pencil, Plus, Send, Trash2, X } from 'lucide-react';

import { AnimalAvatarImage, BotFace } from '@/modules/user-avatar';
import { ANIMAL_AVATARS } from '@/shared/animalAvatars';
import { BOT_COLORS, BOT_COLOR_CLASS, BOT_COLOR_NAMES, formatBotAvatar, parseBotAvatar } from '@/shared/botAvatar';
import type { BotColor } from '@/shared/botAvatar';
import { removeBot, saveBot, saveMyStyle, useBots, useChatMe } from '@/shared/chatRoom';
import type { BotFields, MyBot, TeamRole } from '@/shared/chatRoom';
import { cn } from '@/shared/utils';

/**
 * DHC CLI 10/25 我的小助理: in the private chat with 團隊小助理, each person adds, edits and deletes up to five own bots,
 * sees the others' public ones and the team roles (copy only), and sets 我的小助理個性. The server checks every field
 * again; this page only counts characters so the limits are visible while typing.
 */
const MAX_BOTS = 5;
const MAX_TEXT = 2000;
const MAX_STYLE = 500;
const chars = (text: string) => Array.from(text).length;
type Draft = BotFields & { id?: string; mentionText: string };
function EMPTY_FIELDS(): Draft {
  return { name: '', mentions: [], mentionText: '', avatar: '', duty: '', style: '', visibility: 'private' };
}
const EMPTY: Draft = EMPTY_FIELDS();
/** 10/25: 呼叫詞 left empty means @name (spaces dropped), so name and 負責什麼 are enough to save. */
const defaultMention = (name: string) => `@${name.replace(/\s+/g, '')}`;
/** 10/25: four ready-made helpers for middle-office work, plain words; each one only reads and drafts, never changes data. */
const TEMPLATES: Draft[] = [
  { ...EMPTY_FIELDS(), name: '對帳小幫手', avatar: '對', duty: '幫我核對兩份資料（例如部位表和成交明細、系統報表和 Excel）。先講有沒有差異、差幾筆，再逐筆列出差在哪一欄、可能的原因；看不出原因就直說，不要硬湊。只查不改。', style: '先講結論，差異用表格列，五行內講完。' },
  { ...EMPTY_FIELDS(), name: 'SQL 小幫手', avatar: 'S', duty: '幫我寫或檢查 SQL Server 查詢。先問清楚要查哪張表、什麼條件；用暫存表分段寫，讓中間結果可以叫出來看；只寫查詢，不寫刪除或修改資料的語法。寫好的 SQL 整段攤開給我核對。', style: '先給能直接執行的 SQL，再用一兩句說明每段在做什麼。' },
  { ...EMPTY_FIELDS(), name: '報表摘要', avatar: '摘', duty: '我貼報表或一段數字給你，幫我整理成三到五點重點：哪裡變多、哪裡變少、有沒有看起來不對的地方。只整理我給的內容，不自己補數字；看不懂的欄位先問我。', style: '條列，每點一行，數字照原樣寫。' },
  { ...EMPTY_FIELDS(), name: '會議紀錄整理', avatar: '會', duty: '我貼會議筆記或逐字稿，幫我整理成三段：結論、待辦（誰、做什麼、什麼時候）、還沒決定的事。沒講到的不要自己補。', style: '三段各一個小標題，待辦用表格。' },
];
const INPUT = 'w-full rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground focus:border-sky-400/60 focus:outline-none focus:ring-2 focus:ring-sky-400/15';

/** 11/04 AI 辦公室 頭像: a character on one of six colours, or one of the animal avatars people use. */
function AvatarField({ value, name, onChange }: { value: string; name: string; onChange: (avatar: string) => void }) {
  const initial = Array.from(name.trim())[0] || '助';
  const face = parseBotAvatar(value, initial);
  const [animals, setAnimals] = useState(face.kind === 'animal');
  const letter = face.kind === 'char' ? face : { kind: 'char' as const, char: initial, color: 'green' as BotColor };
  const tab = (on: boolean, label: string, pick: () => void) => (
    <button type="button" aria-pressed={on} onClick={pick} className={cn('rounded-md px-2 py-0.5 transition', on ? 'bg-foreground text-background' : 'border border-border hover:bg-muted')}>{label}</button>
  );
  return (
    <div data-testid="bot-avatar-field" className="space-y-1.5 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-2">
        <span>頭像</span>
        <BotFace avatar={value || initial} className="h-8 w-8 shrink-0 text-xs" />
        {tab(!animals, '文字', () => { setAnimals(false); if (face.kind === 'animal') onChange(formatBotAvatar(letter)); })}
        {tab(animals, '動物', () => setAnimals(true))}
      </div>
      {animals ? (
        <div className="grid grid-cols-8 gap-1">
          {ANIMAL_AVATARS.map((avatar) => (
            <button key={avatar.id} type="button" title={avatar.name} aria-label={avatar.name} aria-pressed={face.kind === 'animal' && face.id === avatar.id} onClick={() => onChange(`animal:${avatar.id}`)} className={cn('rounded-full p-0.5 transition hover:bg-muted', face.kind === 'animal' && face.id === avatar.id && 'ring-2 ring-sky-500')}>
              <AnimalAvatarImage avatarId={avatar.id} className="h-7 w-7" />
            </button>
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <input aria-label="頭像字" value={letter.char} onChange={(event) => onChange(formatBotAvatar({ ...letter, char: Array.from(event.target.value.trim()).slice(-1).join('') || initial }))} className={cn(INPUT, 'w-10 text-center')} />
          {BOT_COLORS.map((color) => (
            <button key={color} type="button" aria-label={`${BOT_COLOR_NAMES[color]}色底`} aria-pressed={letter.color === color} onClick={() => onChange(formatBotAvatar({ ...letter, color }))} className={cn('h-5 w-5 rounded-full bg-gradient-to-br transition', BOT_COLOR_CLASS[color], letter.color === color && 'ring-2 ring-sky-500 ring-offset-1 ring-offset-background')} />
          ))}
        </div>
      )}
    </div>
  );
}

function BotForm({ draft, onDone }: { draft: Draft; onDone: (saved?: { name: string; mention: string }) => void }) {
  const me = useChatMe();
  const [form, setForm] = useState<Draft>(draft);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Draft>) => setForm((current) => ({ ...current, ...patch }));
  const used = chars(form.duty) + chars(form.style);
  const save = async () => {
    if (!me || saving) return;
    setSaving(true);
    setError('');
    const typed = form.mentionText.split(/[,，、\s]+/).filter(Boolean).map((word) => (word.startsWith('@') ? word : `@${word}`));
    const mentions = typed.length > 0 ? typed : [defaultMention(form.name)];
    const fields: BotFields = { name: form.name.trim(), mentions, avatar: form.avatar.trim() || Array.from(form.name.trim())[0] || '', duty: form.duty, style: form.style, visibility: form.visibility };
    const reason = await saveBot(me, fields, form.id);
    setSaving(false);
    if (reason) setError(reason);
    else onDone({ name: fields.name, mention: mentions[0] });
  };
  return (
    <div data-testid="my-bot-form" className="space-y-2 rounded-xl border border-sky-300/60 bg-sky-50/50 p-2.5 dark:border-sky-400/30 dark:bg-sky-500/5">
      <div className="text-xs font-semibold text-foreground">{form.id ? '編輯小助理' : '新增小助理'}</div>
      <label className="block text-[11px] text-muted-foreground">名字（12 字內，聊天室裡就顯示這個名字）
        <input value={form.name} maxLength={12} onChange={(event) => set({ name: event.target.value })} className={INPUT} placeholder="例：算帳仔" />
      </label>
      <AvatarField value={form.avatar} name={form.name} onChange={(avatar) => set({ avatar })} />
      <label className="block text-[11px] text-muted-foreground">@呼叫詞
        <input value={form.mentionText} onChange={(event) => set({ mentionText: event.target.value })} className={INPUT} placeholder="@算帳 @對帳" data-tutorial-tip={`選填，1–3 個，空白隔開；不填就用 ${form.name.trim() ? defaultMention(form.name) : '@名字'}`} />
      </label>
      <label className="block text-[11px] text-muted-foreground">負責什麼
        <textarea value={form.duty} rows={4} onChange={(event) => set({ duty: event.target.value })} className={INPUT} placeholder="例：幫我對帳，先列差異再講原因" />
      </label>
      <label className="block text-[11px] text-muted-foreground">回話風格（選填）
        <textarea value={form.style} rows={2} onChange={(event) => set({ style: event.target.value })} className={INPUT} placeholder="例：口氣輕鬆，三行內" />
      </label>
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className={cn('tabular-nums', used > MAX_TEXT && 'font-semibold text-rose-600')}>{used}/{MAX_TEXT} 字</span>
        <label className="flex items-center gap-1"><input type="radio" checked={form.visibility === 'private'} onChange={() => set({ visibility: 'private' })} className="h-3 w-3" />私人（別人叫要先問你）</label>
        <label className="flex items-center gap-1"><input type="radio" checked={form.visibility === 'public'} onChange={() => set({ visibility: 'public' })} className="h-3 w-3" />公開</label>
      </div>
      {error && <div role="alert" className="text-[11px] text-rose-600 dark:text-rose-300">{error}</div>}
      <div className="flex gap-1.5">
        <button type="button" disabled={saving} onClick={() => void save()} className="rounded-md bg-sky-500 px-2.5 py-1 text-xs font-semibold text-white transition hover:bg-sky-600 disabled:opacity-50">{saving ? '儲存中…' : '儲存'}</button>
        <button type="button" disabled={saving} onClick={() => onDone()} className="rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground transition hover:text-foreground disabled:opacity-50">取消</button>
      </div>
    </div>
  );
}

function BotRow({ avatar, name, mentions, note, children }: { avatar: string; name: string; mentions: string[]; note: string; children?: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-border/70 bg-card p-2">
      <BotFace avatar={avatar} className="h-7 w-7 shrink-0 text-xs" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium text-foreground">{name}</span>
          <span className="truncate text-[11px] text-sky-600 dark:text-sky-300">{mentions.join(' ')}</span>
        </div>
        <div className="line-clamp-2 text-[11px] text-muted-foreground">{note}</div>
      </div>
      {children}
    </div>
  );
}

const fromBot = (bot: MyBot): Draft => ({ id: bot.id, name: bot.name, mentions: bot.mentions, mentionText: bot.mentions.join(' '), avatar: bot.avatar, duty: bot.duty, style: bot.style, visibility: bot.visibility });
const fromRole = (role: TeamRole): Draft => ({ ...EMPTY, name: Array.from(`我的${role.name}`).slice(0, 12).join(''), avatar: Array.from(role.name)[0] ?? '', duty: role.prompt });

/** `startNew` opens the add form at once (the 建一個小助理 starter); `onTry` sends a first call to the private chat. */
export default function MyBots({ onClose, onTry, startNew = false }: { onClose: () => void; onTry?: (mention: string) => void; startNew?: boolean }) {
  const me = useChatMe();
  const bots = useBots();
  const [draft, setDraft] = useState<Draft | null>(startNew ? EMPTY : null);
  // 10/25: right after a save, where and how to call it, and 現在試叫.
  const [saved, setSaved] = useState<{ name: string; mention: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [style, setStyle] = useState(bots.myStyle);
  const [styleNote, setStyleNote] = useState('');
  useEffect(() => setStyle(bots.myStyle), [bots.myStyle]);
  const remove = async (id: string) => {
    if (!me) return;
    const reason = await removeBot(me, id);
    setConfirming(null);
    setError(reason ?? '');
  };
  const keepStyle = async () => {
    if (!me) return;
    const reason = await saveMyStyle(me, style);
    setStyleNote(reason ?? '已儲存');
  };
  return (
    <div data-testid="my-bots" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">我的小助理</span>
        <button type="button" aria-label="回私聊" onClick={onClose} className="ml-auto rounded-lg p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"><X className="h-4 w-4" /></button>
      </div>

      <section className="space-y-1.5">
        <div className="text-xs font-semibold text-foreground">我的小助理個性</div>
        <p data-tutorial className="text-[11px] text-muted-foreground">只套用在你叫的時候，例如「回短一點、叫我同事B」。</p>
        <textarea value={style} rows={2} onChange={(event) => { setStyle(event.target.value); setStyleNote(''); }} className={INPUT} />
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className={cn('tabular-nums', chars(style) > MAX_STYLE && 'font-semibold text-rose-600')}>{chars(style)}/{MAX_STYLE} 字</span>
          <button type="button" onClick={() => void keepStyle()} className="rounded-md bg-sky-500 px-2 py-0.5 font-semibold text-white transition hover:bg-sky-600">儲存個性</button>
          {styleNote && <span>{styleNote}</span>}
        </div>
      </section>

      {saved && (
        <div data-testid="my-bot-saved" className="flex flex-wrap items-center gap-2 rounded-xl border border-green-400/60 bg-green-50/70 p-2 text-xs text-foreground dark:border-green-500/30 dark:bg-green-500/10">
          <span className="min-w-0 flex-1">已存好「{saved.name}」。在任何聊天打 <b>{saved.mention}</b> 就能叫它。</span>
          {onTry && (
            <button type="button" onClick={() => onTry(saved.mention)} className="flex shrink-0 items-center gap-1 rounded-md bg-green-500 px-2.5 py-1 font-semibold text-white transition hover:bg-green-600">
              <Send className="h-3 w-3" />現在試叫
            </button>
          )}
          <button type="button" aria-label="知道了" onClick={() => setSaved(null)} className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      {draft && <BotForm key={draft.id ?? draft.name} draft={draft} onDone={(done) => { setDraft(null); if (done) setSaved(done); }} />}

      <section className="space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-foreground">我的（{bots.mine.length}/{MAX_BOTS}）</span>
          <button type="button" disabled={bots.mine.length >= MAX_BOTS || draft !== null} onClick={() => setDraft(EMPTY)} className="ml-auto flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40">
            <Plus className="h-3 w-3" />新增
          </button>
        </div>
        {!draft && bots.mine.length < MAX_BOTS && (
          <div data-testid="my-bot-templates" className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <span>用範本：</span>
            {TEMPLATES.map((template) => (
              <button key={template.name} type="button" onClick={() => { setSaved(null); setDraft(template); }} className="rounded-full border border-sky-300/70 bg-sky-50/70 px-2 py-0.5 text-sky-700 transition hover:bg-sky-100 dark:border-sky-400/30 dark:bg-sky-500/10 dark:text-sky-300">
                {template.name}
              </button>
            ))}
          </div>
        )}
        {bots.mine.length === 0 && <p className="text-[11px] text-muted-foreground">還沒有。<span data-tutorial>按新增、挑一個範本，或從下面的團隊角色複製一份來改。</span></p>}
        {bots.mine.map((bot) => (
          <BotRow key={bot.id} avatar={bot.avatar} name={bot.name} mentions={bot.mentions} note={`${bot.visibility === 'public' ? '公開' : '私人'} · ${bot.duty}`}>
            {confirming === bot.id ? (
              <span className="flex shrink-0 items-center gap-1 text-[11px]">
                <span className="text-rose-600 dark:text-rose-300">確定刪除？</span>
                <button type="button" onClick={() => void remove(bot.id)} className="rounded-md bg-rose-500 px-1.5 py-0.5 font-semibold text-white hover:bg-rose-600">刪除</button>
                <button type="button" onClick={() => setConfirming(null)} className="rounded-md border border-border px-1.5 py-0.5 text-muted-foreground hover:text-foreground">不要</button>
              </span>
            ) : (
              <span className="flex shrink-0 gap-0.5">
                <button type="button" aria-label="編輯" onClick={() => setDraft(fromBot(bot))} className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"><Pencil className="h-3.5 w-3.5" /></button>
                <button type="button" aria-label="刪除" onClick={() => setConfirming(bot.id)} className="rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></button>
              </span>
            )}
          </BotRow>
        ))}
        {error && <div role="alert" className="text-[11px] text-rose-600 dark:text-rose-300">{error}</div>}
      </section>

      <section className="space-y-1.5">
        <div className="text-xs font-semibold text-foreground">別人公開的</div>
        {bots.public.length === 0 && <p className="text-[11px] text-muted-foreground">目前沒有。</p>}
        {bots.public.map((bot) => <BotRow key={bot.id} avatar={bot.avatar} name={bot.name} mentions={bot.mentions} note={`${bot.ownerName} 的 · ${bot.duty}`} />)}
      </section>

      <section className="space-y-1.5">
        <div className="text-xs font-semibold text-foreground">團隊</div>
        {bots.team.map((role) => (
          <BotRow key={role.id} avatar={Array.from(role.name)[0] ?? ''} name={role.name} mentions={role.mentions} note={`團隊 · ${role.prompt}`}>
            <button type="button" disabled={bots.mine.length >= MAX_BOTS || draft !== null} onClick={() => setDraft(fromRole(role))} className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40">
              <Copy className="h-3 w-3" />複製
            </button>
          </BotRow>
        ))}
      </section>
    </div>
  );
}
