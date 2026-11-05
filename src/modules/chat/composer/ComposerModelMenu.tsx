import { memo, useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import type { ProviderModelOption } from '@/shared/types';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { useComposerMenuAnchor } from '@/modules/chat/hooks/useComposerMenuAnchor';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerMenuSurface,
} from '@/modules/chat/composer/ComposerMenuPrimitives';

// Short Chinese names for the effort levels; an unknown level shows as the server names it.
const EFFORT_TEXT: Record<string, string> = {
  [DEFAULT_EFFORT_VALUE]: '預設',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
  ultracode: '程式特強',
};
const EFFORT_HINT: Record<string, string> = {
  [DEFAULT_EFFORT_VALUE]: '照模型預設',
  low: '快、省額度，適合簡單問題',
  medium: '一般工作的平衡選擇',
  high: '想得更久，較準',
  xhigh: '難題用，較慢、較耗額度',
  max: '最深入，最慢、最耗額度',
  ultracode: '寫程式專用，最耗額度',
};
const effortText = (value: string) => EFFORT_TEXT[value] ?? value;

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];

type ComposerModelMenuProps = {
  effort: string;
  /** Effort values the active provider/model actually accepts; empty hides the section. */
  effortOptions: EffortOption[];
  onSelectEffort: (effort: string) => void;
  model: string;
  /** Model catalog for the active provider; empty hides the section. */
  modelOptions: ProviderModelOption[];
  onSelectModel: (model: string) => void;
  modelsLoading: boolean;
};

/**
 * Rendered by chat's ChatComposer as the popover for choosing the active
 * provider's model and reasoning effort for the next turn.
 */
function ComposerModelMenu({
  effort,
  effortOptions,
  onSelectEffort,
  model,
  modelOptions,
  onSelectModel,
  modelsLoading,
}: ComposerModelMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);

  const resolvedEffortOptions = useMemo<EffortOption[]>(
    () => (effortOptions.length > 0 ? [{ value: DEFAULT_EFFORT_VALUE }, ...effortOptions] : []),
    [effortOptions],
  );
  const effortLabel = effortText(effort);

  const selectedModelOption = useMemo(
    () => modelOptions.find((option) => option.value === model) ?? null,
    [model, modelOptions],
  );
  const modelLabel = selectedModelOption?.label || model;

  const hasEffortSection = resolvedEffortOptions.length > 0;
  const hasModelSection = modelOptions.length > 0 || modelsLoading;
  if (!hasEffortSection && !hasModelSection) {
    return null;
  }

  const triggerLabel = hasModelSection ? modelLabel : effortLabel;
  const ariaLabel = '選擇模型與思考強度';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className="flex h-8 max-w-20 shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted sm:max-w-56"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={ariaLabel}
        data-tutorial-tip="模型：選這個對話用哪個模型，以及思考強度"
      >
        <span className="truncate">{triggerLabel}</span>
        {hasModelSection && hasEffortSection && effort !== DEFAULT_EFFORT_VALUE && (
          <span className="hidden shrink-0 text-muted-foreground sm:inline">· {effortLabel}</span>
        )}
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          {hasModelSection && (
            <>
              <ComposerMenuHeading>模型</ComposerMenuHeading>
              {modelOptions.length === 0 && modelsLoading && (
                <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                  載入模型中…
                </p>
              )}
              {modelOptions.map((option) => (
                <ComposerMenuItem
                  key={option.value}
                  label={option.label || option.value}
                  isSelected={option.value === model}
                  onSelect={() => {
                    onSelectModel(option.value);
                    setIsOpen(false);
                  }}
                />
              ))}
            </>
          )}

          {hasEffortSection && (
            <>
              {hasModelSection && <ComposerMenuSeparator />}
              <ComposerMenuHeading>思考強度</ComposerMenuHeading>
              {resolvedEffortOptions.map((option) => (
                <ComposerMenuItem
                  key={option.value}
                  label={effortText(option.value)}
                  description={EFFORT_HINT[option.value]}
                  isSelected={option.value === effort}
                  onSelect={() => {
                    onSelectEffort(option.value);
                    setIsOpen(false);
                  }}
                />
              ))}
            </>
          )}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}

/** Memoized: the composer re-renders on every keystroke and none of this menu's props change while typing. */
export default memo(ComposerModelMenu);
