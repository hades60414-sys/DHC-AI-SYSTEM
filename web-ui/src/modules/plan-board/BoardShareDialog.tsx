import { useEffect, useState } from 'react';

/**
 * Who to draw this board with: everyone else with a project, ticked if already in; a note goes with the invitation.
 * 11/01: Esc and a click outside close it, like the tool library.
 */
export default function BoardShareDialog({ boardName, me, members, people, onCancel, onSave }: {
  boardName: string;
  me: string;
  members: string[];
  people: ReadonlyMap<string, { name: string }>;
  onCancel: () => void;
  onSave: (members: string[], message: string) => Promise<void>;
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set(members));
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const others = [...people.entries()].filter(([projectId]) => projectId !== me).sort((a, b) => a[1].name.localeCompare(b[1].name));
  const toggle = (projectId: string) => setPicked((set) => {
    const next = new Set(set);
    if (next.has(projectId)) next.delete(projectId);
    else next.add(projectId);
    return next;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);
  const stopping = members.length > 0 && picked.size === 0;
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-background/60 backdrop-blur-sm"
      role="dialog"
      aria-label="Co-Work 白板"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}
    >
      <div className="w-80 max-w-[92vw] rounded-lg border border-border bg-background p-4 text-sm shadow-xl">
        <p className="mb-1 font-semibold text-foreground">Co-Work：{boardName}</p>
        <p data-tutorial className="mb-3 text-xs leading-relaxed text-muted-foreground">
          勾選的人會在他們的白板清單看到這張圖，可以一起畫、一起問 AI；大家改的地方約 5 秒合併一次。全部取消勾選＝停止共享，白板回到你自己的清單。
        </p>
        <div className="mb-3 max-h-56 space-y-1 overflow-y-auto">
          {others.length === 0 && <p className="text-xs text-muted-foreground">還找不到其他人（同事要先在這台主機有自己的專案）。</p>}
          {others.map(([projectId, person]) => (
            <label key={projectId} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-muted">
              <input type="checkbox" checked={picked.has(projectId)} onChange={() => toggle(projectId)} />
              <span className="text-foreground">{person.name}</span>
            </label>
          ))}
        </div>
        <textarea
          aria-label="邀請留言"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => event.stopPropagation()}
          rows={2}
          placeholder="留言（選填）"
          data-tutorial-tip="給對方的話，例如：幫我看資料流程對不對"
          className="mb-3 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary"
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted">取消</button>
          <button
            type="button"
            disabled={saving || (members.length === 0 && picked.size === 0)}
            onClick={async () => {
              setSaving(true);
              await onSave([...picked], message);
              setSaving(false);
            }}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-40"
          >
            {stopping ? '停止共享' : '儲存'}
          </button>
        </div>
      </div>
    </div>
  );
}
