import { THEMES, useTheme } from '@/shared/context/ThemeContext';
import { cn } from '@/shared/utils';

/** DHC CLI: theme cards — each shows a tiny preview (background, main colour, accent) and its name. */
export function ThemePicker({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  return (
    <div role="radiogroup" aria-label="主題" className={cn('grid grid-cols-3 gap-1.5', className)}>
      {THEMES.map((option) => {
        const [bg, main, accent] = option.swatch;
        const selected = theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={option.label}
            onClick={() => setTheme(option.value)}
            className={cn(
              'flex min-w-0 flex-col items-stretch gap-1 rounded-lg border p-1 text-left transition-colors',
              selected
                ? 'border-primary ring-1 ring-primary'
                : 'border-border hover:border-muted-foreground/40',
            )}
          >
            <span
              aria-hidden
              className="relative flex h-7 items-end gap-1 overflow-hidden rounded-md px-1.5 pb-1.5"
              style={{ background: bg, boxShadow: 'inset 0 0 0 1px rgb(127 127 127 / 0.18)' }}
            >
              <span className="h-2 w-5 rounded-full" style={{ background: main }} />
              <span className="h-2 w-2 rounded-full" style={{ background: accent }} />
            </span>
            <span
              className={cn(
                'truncate px-0.5 text-xs',
                selected ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
