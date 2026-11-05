import { Dialog, DialogContent, DialogTitle } from '@/shared/ui/Dialog';
import { CLOUD_CONFIRM_TEXT } from '@/modules/chat/hooks/voiceMode';

type Props = {
  open: boolean;
  onResolve: (ok: boolean) => void;
};

// 雲端語音的外傳確認（每台裝置只問第一次，見 voiceMode 的 hasAcceptedCloud）；取消就不錄。
export default function VoiceCloudConfirm({ open, onResolve }: Props) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onResolve(false); }}>
      <DialogContent className="max-w-sm p-5">
        <DialogTitle className="mb-2 text-base font-semibold">使用雲端語音辨識</DialogTitle>
        <p className="mb-4 text-sm text-muted-foreground">{CLOUD_CONFIRM_TEXT}</p>
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-md border px-3 py-1.5 text-sm" onClick={() => onResolve(false)}>
            取消
          </button>
          <button type="button" className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={() => onResolve(true)}>
            確定
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
