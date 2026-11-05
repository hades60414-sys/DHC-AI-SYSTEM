import { Sparkles } from 'lucide-react';
import { useState } from 'react';

import { SETTING_ROW_CLASS } from '@/shared/constants';
import { readModelAdviceMode, writeModelAdviceMode, type ModelAdviceMode } from '@/modules/chat/utils/modelAdvice';
import QuickSettingsSection from '@/modules/quick-settings-panel/QuickSettingsSection';

const OPTIONS: Array<{ value: ModelAdviceMode; label: string }> = [
  { value: 'auto', label: '自動判斷（簡單題改用 Sonnet，最多等 6 秒）' },
  { value: 'off', label: '關閉' },
];

/** DHC CLI 開對話建議模型: whether a new Opus chat's first message gets a "Sonnet is enough" check. */
export default function ModelAdviceSetting() {
  const [mode, setMode] = useState<ModelAdviceMode>(readModelAdviceMode);
  return (
    <QuickSettingsSection title="開對話建議模型">
      <label className={SETTING_ROW_CLASS}>
        <span className="flex items-center gap-2 text-sm text-foreground">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          簡單的題目改用 Sonnet
        </span>
        <select
          value={mode}
          onChange={(event) => {
            const next = event.target.value as ModelAdviceMode;
            writeModelAdviceMode(next);
            setMode(next);
          }}
          className="rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
        >
          {OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <p className="ml-3 text-xs text-muted-foreground">
        只看新對話的第一則、而且選的是 Opus 時才判斷。算錢、改程式、寫 SQL 一律留 Opus。
      </p>
    </QuickSettingsSection>
  );
}
