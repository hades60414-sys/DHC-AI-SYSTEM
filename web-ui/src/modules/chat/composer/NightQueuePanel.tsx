import { useTranslation } from 'react-i18next';
import { AlertTriangle, Loader2, Moon, X } from 'lucide-react';

import type { NightQueueItem } from '@/shared/types';
import type { NightQueueControls } from '@/modules/chat/composer/useNightQueue';
import { formatStartAt } from '@/modules/chat/utils/nightQueueTime';

/** The server's window (02:00–07:00 local); only used to word the waiting label. */
function isNightWindowNow(): boolean {
  const hour = new Date().getHours();
  return hour >= 2 && hour < 7;
}

/** Shown when the moon is pressed in a chat that is not in bypass mode: nobody is there at night to approve. */
function BypassQuestion({
  onAnswer,
  onCancel,
}: {
  onAnswer: (useBypass: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation('chat');
  return (
    <div
      role="dialog"
      aria-label={t('nightQueue.bypassQuestion.title')}
      className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-xs text-foreground"
    >
      <p>{t('nightQueue.bypassQuestion.body')}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onAnswer(true)}
          className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground transition-opacity hover:opacity-90"
        >
          {t('nightQueue.bypassQuestion.yes')}
        </button>
        <button
          type="button"
          onClick={() => onAnswer(false)}
          className="rounded-md border border-border/60 px-3 py-1.5 font-medium text-foreground transition-colors hover:bg-muted"
        >
          {t('nightQueue.bypassQuestion.no')}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {t('nightQueue.bypassQuestion.cancel')}
        </button>
      </div>
    </div>
  );
}

function useItemLabel() {
  const { t } = useTranslation('chat');
  return (item: NightQueueItem): string => {
    if (item.status === 'running') {
      return t('nightQueue.status.running');
    }
    if (item.status === 'failed') {
      return t('nightQueue.status.failed', { reason: item.failureReason ?? '' });
    }
    const position = item.position ?? 0;
    if (item.failureReason) {
      // A try that failed (usage limit, API error) waits for the next one; say why it is still here.
      const reason = item.failureReason.length > 80 ? `${item.failureReason.slice(0, 79)}…` : item.failureReason;
      return t('nightQueue.status.retrying', { position, reason });
    }
    if (item.runNow) {
      return t('nightQueue.status.runNow', { position });
    }
    if (item.startAt) {
      return new Date(item.startAt).getTime() <= Date.now()
        ? t('nightQueue.status.waitingInWindow', { position })
        : t('nightQueue.status.waitingAlarm', { position, time: formatStartAt(item.startAt) });
    }
    return isNightWindowNow()
      ? t('nightQueue.status.waitingInWindow', { position })
      : t('nightQueue.status.waiting', { position });
  };
}

/**
 * DHC CLI: rendered by ChatComposer above the input. Asks about bypass when the moon is turned on in a chat
 * that is not in bypass mode, says night mode is on (and how to give one prompt its own time), asks what to do
 * with waiting prompts when the moon is pressed again, and lists this chat's prompts with their place in the
 * queue — each one can be taken back, and a failed one dismissed.
 */
export function NightQueuePanel({
  enabled,
  mode,
  items,
  pendingCount,
  isAskingBypass,
  isConfirming,
  notice,
  onAnswerBypass,
  onCancelBypass,
  onRunNow,
  onCancelAll,
  onCloseConfirm,
  onCancelItem,
}: NightQueueControls) {
  const { t } = useTranslation('chat');
  const labelFor = useItemLabel();

  if (!enabled && items.length === 0 && !isConfirming && !isAskingBypass && !notice) {
    return null;
  }

  const banner = mode
    ? `${t('nightQueue.banner')}${mode.useBypass ? ` ${t('nightQueue.bannerBypass')}` : ''}`
    : null;

  return (
    <div className="mx-auto mb-2 flex max-w-[54.25rem] flex-col gap-1.5">
      {isAskingBypass ? (
        <BypassQuestion onAnswer={onAnswerBypass} onCancel={onCancelBypass} />
      ) : isConfirming ? (
        <div
          role="alertdialog"
          aria-label={t('nightQueue.confirm.title')}
          className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-xs text-foreground"
        >
          <p>{t('nightQueue.confirm.body', { count: pendingCount })}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onRunNow}
              className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              {t('nightQueue.confirm.runNow')}
            </button>
            <button
              type="button"
              onClick={onCancelAll}
              className="rounded-md border border-red-500/40 px-3 py-1.5 font-medium text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
            >
              {t('nightQueue.confirm.cancelAll')}
            </button>
            <button
              type="button"
              onClick={onCloseConfirm}
              className="rounded-md px-3 py-1.5 font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {t('nightQueue.confirm.back')}
            </button>
          </div>
        </div>
      ) : banner && (
        <div className="flex items-start gap-2 rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-xs text-foreground">
          <Moon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-600 dark:text-indigo-300" />
          <span className="min-w-0 flex-1">{banner}</span>
        </div>
      )}

      {notice && (
        <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-foreground">
          {notice}
        </p>
      )}

      {items.map((item) => {
        const isFailed = item.status === 'failed';
        const isRunning = item.status === 'running';
        return (
          <div
            key={item.id}
            className={`flex items-start gap-2 rounded-xl border px-3 py-2 text-xs ${
              isFailed ? 'border-red-500/30 bg-red-500/10' : 'border-border/60 bg-muted/40'
            }`}
          >
            {isFailed ? (
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
            ) : isRunning ? (
              <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-indigo-500" />
            ) : (
              <Moon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-muted-foreground">
                {labelFor(item)}
                {item.attachmentCount > 0 && ` · ${t('nightQueue.attachments', { count: item.attachmentCount })}`}
              </p>
              <p className="mt-0.5 truncate text-foreground">{item.content}</p>
            </div>
            {!isRunning && (
              <button
                type="button"
                onClick={() => onCancelItem(item.id)}
                title={isFailed ? t('nightQueue.dismiss') : t('nightQueue.cancelItem')}
                aria-label={isFailed ? t('nightQueue.dismiss') : t('nightQueue.cancelItem')}
                className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
