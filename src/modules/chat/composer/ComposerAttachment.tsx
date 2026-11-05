import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileIcon, PencilIcon, XIcon } from 'lucide-react';

import ImageAnnotator from '@/modules/chat/composer/ImageAnnotator';

type ComposerAttachmentProps = {
  file: File;
  onRemove: () => void;
  /** DHC CLI: swaps in the marked-up image; without it the image cannot be edited. */
  onReplace?: (file: File) => void;
  error?: string;
  /** DHC CLI: chunked-upload progress 0–1; absent when not uploading. */
  progress?: number;
};

const formatFileSize = (size: number) => {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Rendered by chat's ChatComposer for each pending attachment, showing its
 * thumbnail or file chip, upload progress and remove control.
 * DHC CLI 11/01: clicking an image opens the annotator directly (it has its own zoom), so there is
 * no separate lightbox; the always-visible pencil only tells people the image can be edited.
 */
const ComposerAttachment = ({ file, onRemove, onReplace, error, progress }: ComposerAttachmentProps) => {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const isImage = file.type.startsWith('image/');

  useEffect(() => {
    if (!isImage) {
      setPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, isImage]);

  return (
    <div className="group relative max-w-full">
      {isImage ? (
        <button
          type="button"
          onClick={() => preview && onReplace && setEditing(true)}
          title={onReplace ? '編輯圖片：畫筆、方框、文字' : undefined}
          aria-label={t('chat:misc.editFile', { name: file.name })}
          data-testid="composer-attachment-edit"
          className="block overflow-hidden rounded-xl border border-border/50 shadow-sm focus:outline-none focus:ring-2 focus:ring-primary/60"
        >
          {preview
            ? <img src={preview} alt={file.name} className={`h-20 w-20 object-cover ${onReplace ? 'cursor-pointer' : ''}`} />
            : <div className="h-20 w-20 animate-pulse bg-muted" />}
        </button>
      ) : (
        <div className="flex h-20 w-56 max-w-full items-center gap-3 rounded-xl border border-border/50 bg-background/80 px-3 shadow-sm">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileIcon className="h-5 w-5" aria-hidden />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground" title={file.name}>{file.name}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
          </div>
        </div>
      )}
      {progress !== undefined && (
        <div
          className="pointer-events-none absolute inset-x-1 bottom-1 h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={Math.round(progress * 100)}
          title={`上傳中 ${Math.round(progress * 100)}%`}
        >
          <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {error && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-xl bg-red-500/50">
          <svg className="h-6 w-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        className="absolute -right-1.5 -top-1.5 rounded-full border border-border/40 bg-background/90 p-1 text-foreground shadow-sm backdrop-blur transition-opacity hover:bg-background focus:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
        aria-label={t('chat:misc.removeFile', { name: file.name })}
      >
        <XIcon className="h-3 w-3" aria-hidden />
      </button>
      {isImage && onReplace && (
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="編輯圖片：畫筆、方框、文字"
          aria-hidden
          tabIndex={-1}
          className="absolute -left-1.5 -top-1.5 rounded-full border border-border/40 bg-background/90 p-1 text-foreground shadow-sm backdrop-blur hover:bg-background"
        >
          <PencilIcon className="h-3 w-3" aria-hidden />
        </button>
      )}
      {editing && onReplace && (
        <ImageAnnotator
          file={file}
          onCancel={() => setEditing(false)}
          onDone={(edited) => {
            setEditing(false);
            onReplace(edited);
          }}
        />
      )}
    </div>
  );
};

export default ComposerAttachment;
