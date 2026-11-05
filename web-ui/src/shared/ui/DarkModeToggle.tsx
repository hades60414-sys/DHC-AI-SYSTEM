import { Moon, Sun, type LucideIcon } from 'lucide-react';

import { useTheme } from '@/shared/context/ThemeContext';
import { cn } from '@/shared/utils';

type DarkModeToggleProps = {
  checked?: boolean;
  onToggle?: (nextValue: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
  /** Own knob icon for other on/off settings (極簡模式); without it the knob shows Moon / Sun. */
  icon?: LucideIcon;
};

/** Used by the settings and quick-settings-panel modules to switch the shared theme. */
export function DarkModeToggle({
  checked,
  onToggle,
  ariaLabel = 'Toggle dark mode',
  disabled,
  icon: KnobIcon,
}: DarkModeToggleProps) {
  const { isDarkMode, toggleDarkMode } = useTheme();
  const isControlled = typeof checked === 'boolean' && typeof onToggle === 'function';
  const isEnabled = isControlled ? checked : isDarkMode;

  const handleToggle = () => {
    if (isControlled && onToggle) {
      onToggle(!isEnabled);
      return;
    }

    toggleDarkMode();
  };

  return (
    <button
      onClick={handleToggle}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-7 w-12 flex-shrink-0 touch-manipulation cursor-pointer items-center rounded-full border-2 transition-colors duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        isEnabled ? 'border-primary bg-primary' : 'border-border bg-muted',
        disabled && 'cursor-not-allowed opacity-50',
      )}
      role="switch"
      aria-checked={isEnabled}
      aria-label={ariaLabel}
    >
      <span className="sr-only">{ariaLabel}</span>
      <span
        className={cn(
          'flex h-5 w-5 transform items-center justify-center rounded-full shadow-sm transition-transform duration-200',
          isEnabled ? 'translate-x-[22px] bg-white' : 'translate-x-[2px] bg-foreground/60 dark:bg-foreground/80',
        )}
      >
        {KnobIcon ? (
          <KnobIcon className={cn('h-3 w-3', isEnabled ? 'text-primary' : 'text-white dark:text-background')} />
        ) : isEnabled ? (
          <Moon className="h-3 w-3 text-primary" />
        ) : (
          <Sun className="h-3 w-3 text-white dark:text-background" />
        )}
      </span>
    </button>
  );
}
