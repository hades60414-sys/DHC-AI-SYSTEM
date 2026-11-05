import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { Brush, Download, FileText, Loader2, Paperclip, Pencil, X } from 'lucide-react';

import ImageAnnotator from '@/modules/chat/composer/ImageAnnotator';
import { CHUNKED_UPLOAD_MAX_SIZE, DIRECT_UPLOAD_MAX_SIZE, uploadFileInChunks } from '@/modules/chat/utils/chunkedUpload';
import { api } from '@/shared/api';
import { newChatId, sendChatMessage, useChatMe } from '@/shared/chatRoom';
import type { ChatFile } from '@/shared/chatRoom';

/**
 * DHC CLI 10/19 聊天室傳檔: files and pictures in a message. They are picked, dropped or pasted into the composer,
 * shown as chips (a picture opens the annotator), and only uploaded when 送出 is pressed; the message keeps just the
 * stored name. In the room a picture is a thumbnail that opens large (download, 標註後回傳), anything else a card.
 */
const MAX_FILES = 10;
/** Over this size a picture is not previewed in the room (it would be pulled into memory) and a download goes by link. */
const MAX_PREVIEW = 20 * 1024 * 1024;
const MAX_BLOB_DOWNLOAD = 100 * 1024 * 1024;
const isImage = (type: string) => type.startsWith('image/');

const formatSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

type StoredRecord = { name?: string; path?: string; size?: number; mimeType?: string };

// The name comes from the picked file, not the server's record: the form upload hands Chinese names back garbled.
const toChatFile = (record: StoredRecord, fallback: File): ChatFile => ({
  name: fallback.name,
  stored: (record.path ?? '').split(/[\\/]/).pop() ?? '',
  size: record.size ?? fallback.size,
  type: record.mimeType || fallback.type,
});

/** Files up to 10MB go up in one request, bigger ones in chunks; the result is in the same order as `files`. */
async function uploadChatFiles(files: File[], onProgress: (index: number, fraction: number) => void): Promise<ChatFile[]> {
  const records: StoredRecord[] = new Array(files.length);
  const small = files.flatMap((file, index) => (file.size <= DIRECT_UPLOAD_MAX_SIZE ? [index] : []));
  if (small.length > 0) {
    const formData = new FormData();
    small.forEach((index) => formData.append('files', files[index]));
    const response = await api.assets.uploadFiles(formData);
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.error || `HTTP ${response.status}`);
    }
    const result = await response.json();
    if (!Array.isArray(result.attachments) || result.attachments.length !== small.length) throw new Error('伺服器回傳的檔案不完整');
    small.forEach((index, at) => { records[index] = result.attachments[at]; });
  }
  for (let index = 0; index < files.length; index += 1) {
    if (files[index].size > DIRECT_UPLOAD_MAX_SIZE) records[index] = await uploadFileInChunks(files[index], (fraction) => onProgress(index, fraction)) as StoredRecord;
  }
  return records.map((record, index) => toChatFile(record, files[index]));
}

function blankImage(): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = 1600;
  canvas.height = 1000;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(new File([blob], '畫圖.png', { type: 'image/png', lastModified: Date.now() })) : reject(new Error('畫布建立失敗'))), 'image/png'));
}

// ---- composer ----
type Pending = { id: string; file: File };

export function useComposerFiles() {
  const [pending, setPending] = useState<Pending[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [annotating, setAnnotating] = useState<{ id: string | null; file: File } | null>(null);
  const busyRef = useRef(false);

  const add = (files: File[]) => {
    if (files.length === 0) return;
    const tooBig = files.find((file) => file.size > CHUNKED_UPLOAD_MAX_SIZE);
    const usable = files.filter((file) => file.size <= CHUNKED_UPLOAD_MAX_SIZE);
    setError(tooBig ? `「${tooBig.name}」超過 2GB，沒辦法上傳。` : pending.length + usable.length > MAX_FILES ? `一則訊息最多 ${MAX_FILES} 個檔案。` : '');
    setPending((current) => [...current, ...usable.map((file) => ({ id: newChatId(), file }))].slice(0, MAX_FILES));
  };
  const remove = (id: string) => setPending((current) => current.filter((item) => item.id !== id));
  const replace = (id: string, file: File) => setPending((current) => current.map((item) => (item.id === id ? { ...item, file } : item)));
  const clear = () => {
    setPending([]);
    setProgress({});
    setError('');
  };
  const draw = () => {
    blankImage().then((file) => setAnnotating({ id: null, file })).catch(() => setError('畫布建立失敗'));
  };
  /** Uploads what is pending. A failure leaves everything in place and says why. */
  const upload = async (): Promise<ChatFile[] | null> => {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      return await uploadChatFiles(pending.map((item) => item.file), (index, fraction) => setProgress((current) => ({ ...current, [pending[index].id]: fraction })));
    } catch (failure) {
      setError(`上傳失敗，你打的字和附件都還在，再按一次送出就好。（${failure instanceof Error ? failure.message : String(failure)}）`);
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return { pending, progress, busy, error, annotating, setAnnotating, add, remove, replace, clear, draw, upload };
}
export type ComposerFiles = ReturnType<typeof useComposerFiles>;

/** Drag, drop and paste of files on the composer; the session/board drag from the sidebar is left alone. */
export function fileHandlers(files: ComposerFiles, setOver: (over: boolean) => void) {
  const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  return {
    onDragOver: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      setOver(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(false);
    },
    onDrop: (event: DragEvent) => {
      setOver(false);
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      files.add(Array.from(event.dataTransfer.files));
    },
    onPaste: (event: ClipboardEvent) => {
      const pasted = Array.from(event.clipboardData.files);
      if (pasted.length === 0) return;
      event.preventDefault();
      files.add(pasted);
    },
  };
}

/** 迴紋針 and 畫圖, left of the text box. */
export function FileButtons({ files, disabled, draw = true }: { files: ComposerFiles; disabled: boolean; draw?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const picked = (event: ChangeEvent<HTMLInputElement>) => {
    files.add(Array.from(event.target.files ?? []));
    event.target.value = '';
  };
  const style = 'mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent';
  return (
    <>
      <input ref={input} type="file" multiple hidden data-testid="chat-file-input" onChange={picked} />
      <button type="button" aria-label="附加檔案" title="附加檔案（也可以拖進來或貼上圖片）" disabled={disabled} onClick={() => input.current?.click()} className={style}>
        <Paperclip className="h-4 w-4" />
      </button>
      {draw && <button type="button" aria-label="畫圖" title="畫圖" disabled={disabled} onClick={files.draw} className={style}>
        <Brush className="h-4 w-4" />
      </button>}
    </>
  );
}

function PendingChip({ item, fraction, busy, onRemove, onEdit }: { item: Pending; fraction?: number; busy: boolean; onRemove: () => void; onEdit: () => void }) {
  const image = isImage(item.file.type);
  const [preview, setPreview] = useState('');
  useEffect(() => {
    if (!image) return undefined;
    const url = URL.createObjectURL(item.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [item.file, image]);
  return (
    <div data-testid="chat-file-chip" className="group/chip relative">
      {image ? (
        <button type="button" aria-label={`標註 ${item.file.name}`} title="點一下編輯圖片" disabled={busy} onClick={onEdit} className="block h-20 w-20 overflow-hidden rounded-xl border border-border/50 bg-muted shadow-sm">
          {preview && <img src={preview} alt={item.file.name} className="h-full w-full object-cover" />}
        </button>
      ) : (
        <div className="flex h-20 w-48 items-center gap-2 rounded-xl border border-border/60 bg-card px-2 shadow-sm">
          <FileText className="h-5 w-5 shrink-0 text-sky-500" />
          <span className="min-w-0 text-xs leading-tight"><span className="block truncate text-foreground">{item.file.name}</span><span className="text-[10px] text-muted-foreground">{formatSize(item.file.size)}</span></span>
        </div>
      )}
      {busy && (
        <span className="absolute inset-0 flex items-center justify-center rounded-xl bg-background/70 text-[10px] font-medium text-foreground">
          {fraction === undefined ? <Loader2 className="h-4 w-4 animate-spin" /> : `${Math.round(fraction * 100)}%`}
        </span>
      )}
      {!busy && (
        <button type="button" aria-label={`移除 ${item.file.name}`} onClick={onRemove} className="absolute -right-1.5 -top-1.5 rounded-full border border-border/40 bg-background/90 p-1 text-foreground shadow-sm backdrop-blur hover:bg-background">
          <X className="h-3 w-3" />
        </button>
      )}
      {!busy && image && (
        <button type="button" aria-label={`編輯 ${item.file.name}`} title="編輯圖片：畫筆、方框、文字" data-testid="chat-file-edit" onClick={onEdit} className="absolute -left-1.5 -top-1.5 rounded-full border border-border/40 bg-background/90 p-1 text-foreground shadow-sm backdrop-blur hover:bg-background">
          <Pencil className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** The pending chips above the text box, plus the upload error and the annotator. */
export function PendingFiles({ files }: { files: ComposerFiles }) {
  const { pending, progress, busy, error, annotating, setAnnotating } = files;
  return (
    <>
      {(pending.length > 0 || error) && (
        <div className="mb-2 space-y-1.5">
          {pending.length > 0 && (
            <div className="flex flex-wrap gap-2 px-0.5 pt-1">
              {pending.map((item) => (
                <PendingChip key={item.id} item={item} fraction={progress[item.id]} busy={busy} onRemove={() => files.remove(item.id)} onEdit={() => setAnnotating({ id: item.id, file: item.file })} />
              ))}
            </div>
          )}
          {error && <p role="alert" data-testid="chat-file-error" className="rounded-lg bg-rose-500/10 px-2 py-1 text-xs text-rose-600 dark:text-rose-300">{error}</p>}
        </div>
      )}
      {annotating && (
        <ImageAnnotator
          file={annotating.file}
          onCancel={() => setAnnotating(null)}
          onDone={(edited) => {
            if (annotating.id) files.replace(annotating.id, edited);
            else files.add([edited]);
            setAnnotating(null);
          }}
        />
      )}
    </>
  );
}

// ---- in the room ----
/** The stored file as a blob URL (a bare <img src> cannot carry the auth header); null while loading, 'missing' when it failed. */
function useStoredUrl(file: ChatFile, wanted: boolean) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!wanted) return undefined;
    let made: string | null = null;
    let live = true;
    api.assets.file(file.stored)
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!live) return;
        if (!blob) { setUrl('missing'); return; }
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => { if (live) setUrl('missing'); });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [file.stored, wanted]);
  return url;
}

async function downloadStored(file: ChatFile) {
  const anchor = document.createElement('a');
  anchor.download = file.name;
  let blobUrl: string | null = null;
  if (file.size <= MAX_BLOB_DOWNLOAD) {
    const response = await api.assets.file(file.stored);
    if (!response.ok) return;
    blobUrl = URL.createObjectURL(await response.blob());
    anchor.href = blobUrl;
  } else {
    anchor.href = `/api/assets/files/${encodeURIComponent(file.stored)}`;
  }
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl as string), 10_000);
}

function Viewer({ file, url, onClose, onAnnotate }: { file: ChatFile; url: string; onClose: () => void; onAnnotate: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const button = 'flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-sm text-white transition hover:bg-white/20';
  return createPortal(
    <div data-testid="chat-file-viewer" role="dialog" aria-modal="true" aria-label={file.name} onClick={onClose} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="absolute right-4 top-4 flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
        <button type="button" onClick={onAnnotate} className={button}><Pencil className="h-4 w-4" />標註後回傳</button>
        <button type="button" onClick={() => void downloadStored(file)} className={button}><Download className="h-4 w-4" />下載</button>
        <button type="button" aria-label="關閉" onClick={onClose} className="rounded-full bg-white/10 p-2 text-white transition hover:bg-white/20"><X className="h-5 w-5" /></button>
      </div>
      <img src={url} alt={file.name} onClick={(event) => event.stopPropagation()} className="max-h-[88vh] max-w-[92vw] rounded-lg object-contain shadow-2xl" />
    </div>,
    document.body,
  );
}

function Thumb({ file, onOpen }: { file: ChatFile; onOpen: (url: string) => void }) {
  const url = useStoredUrl(file, file.size <= MAX_PREVIEW);
  if (!url) return <div className="h-24 w-32 animate-pulse rounded-xl bg-muted/60" />;
  if (url === 'missing') return <div data-testid="chat-file-missing" className="rounded-xl border border-dashed border-border/70 px-3 py-2 text-xs text-muted-foreground">圖片「{file.name}」讀不到（檔案不在伺服器上）</div>;
  return (
    <button type="button" data-testid="chat-file-thumb" aria-label={`看大圖 ${file.name}`} onClick={() => onOpen(url)} className="block overflow-hidden rounded-xl border border-border/50 bg-muted shadow-sm">
      <img src={url} alt={file.name} className="max-h-44 max-w-full cursor-zoom-in object-contain" style={{ maxWidth: '14rem' }} />
    </button>
  );
}

function FileCard({ file }: { file: ChatFile }) {
  return (
    <button type="button" data-testid="chat-file-card" title="下載" onClick={() => void downloadStored(file)} className="flex w-full max-w-[14rem] items-center gap-2.5 rounded-xl border border-border/60 bg-card/90 p-2 text-left text-foreground shadow-sm transition hover:border-sky-400/60">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-sky-500"><FileText className="h-5 w-5" /></span>
      <span className="min-w-0 flex-1 leading-tight"><span className="block truncate text-sm">{file.name}</span><span className="text-[10px] opacity-70">{formatSize(file.size)}</span></span>
      <Download className="h-4 w-4 shrink-0 opacity-60" />
    </button>
  );
}

/** The files of one message; 標註後回傳 sends the marked-up picture to the same room as a new message. */
export function MessageFiles({ roomId, files }: { roomId: string; files: ChatFile[] }) {
  const me = useChatMe();
  const [viewing, setViewing] = useState<{ file: ChatFile; url: string } | null>(null);
  const [editing, setEditing] = useState<File | null>(null);
  const [state, setState] = useState<'idle' | 'sending' | string>('idle');
  const annotate = async () => {
    if (!viewing) return;
    const blob = await (await fetch(viewing.url)).blob();
    setEditing(new File([blob], viewing.file.name, { type: viewing.file.type || blob.type, lastModified: Date.now() }));
    setViewing(null);
  };
  const reply = async (edited: File) => {
    setEditing(null);
    if (!me) return;
    setState('sending');
    try {
      const [sent] = await uploadChatFiles([edited], () => undefined);
      sendChatMessage(roomId, { by: me, text: '', refs: [], files: [sent] });
      setState('idle');
    } catch (failure) {
      setState(`標註後的圖沒傳出去：${failure instanceof Error ? failure.message : String(failure)}`);
    }
  };
  return (
    <div className="mt-1.5 flex flex-col items-start gap-1.5 first:mt-0">
      {files.map((file) => (isImage(file.type)
        ? <Thumb key={file.stored} file={file} onOpen={(url) => setViewing({ file, url })} />
        : <FileCard key={file.stored} file={file} />))}
      {state === 'sending' && <span className="text-[11px] opacity-70">傳送標註後的圖…</span>}
      {state !== 'idle' && state !== 'sending' && <span role="alert" className="text-[11px] text-rose-500">{state}</span>}
      {viewing && <Viewer file={viewing.file} url={viewing.url} onClose={() => setViewing(null)} onAnnotate={() => void annotate()} />}
      {editing && <ImageAnnotator file={editing} onCancel={() => setEditing(null)} onDone={(edited) => void reply(edited)} />}
    </div>
  );
}
