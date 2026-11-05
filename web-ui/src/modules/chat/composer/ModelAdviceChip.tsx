import { X } from 'lucide-react';

import type { ModelAdviceChip as Chip } from '@/modules/chat/utils/modelAdvice';

const LABELS: Record<Chip['kind'], string> = {
  suggest: '這題 Sonnet 就夠，按這裡改用 Sonnet（省額度）',
  auto: '這題改用 Sonnet 回答 · 改回 Opus',
};

/** DHC CLI 開對話建議模型: the one-line offer under the composer; the parent switches the model and closes it. */
export default function ModelAdviceChip({ chip, onSwitch, onDismiss }: {
  chip: Chip;
  onSwitch: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="flex justify-center px-4 pb-2">
      <div className="flex items-center gap-1 rounded-full border border-border/60 bg-muted/60 text-xs text-muted-foreground">
        <button type="button" onClick={onSwitch} className="rounded-full py-1 pl-3 pr-1 hover:text-foreground">
          {LABELS[chip.kind]}
        </button>
        <button type="button" onClick={onDismiss} aria-label="關閉" className="rounded-full p-1 pr-2 hover:text-foreground">
          <X className="h-3 w-3" aria-hidden />
        </button>
      </div>
    </div>
  );
}
