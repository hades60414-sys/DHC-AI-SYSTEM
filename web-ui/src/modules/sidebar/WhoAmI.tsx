import { UserRound } from 'lucide-react';

import { OPEN_SETTINGS_PROFILES_EVENT, SettingsProfilePicker } from '@/modules/sidebar/SettingsProfileGate';
import { cn } from '@/shared/utils';

/**
 * DHC CLI 10/25 你是誰: where something needs to know who is at this device (聊天室, 工具開工), the choice is made right
 * there instead of 左下設定 → 專案設定 (on a phone that also meant opening the menu first). `inline` lists the projects in
 * place (SettingsProfilePicker); otherwise one button opens the same list as a window (SettingsProfileGate). Picking
 * reloads the page, as the settings page does, and then everything that needed it works.
 */
export default function WhoAmI({ note, inline = false, className }: { note: string; inline?: boolean; className?: string }) {
  if (inline) {
    return (
      <div data-testid="who-am-i" className={cn('flex min-h-0 flex-col gap-2', className)}>
        <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground"><UserRound className="h-4 w-4" />你是誰？</div>
        <p className="text-xs leading-relaxed text-muted-foreground">{note}</p>
        <div className="flex max-h-72 min-h-0 flex-col"><SettingsProfilePicker /></div>
      </div>
    );
  }
  return (
    <div data-testid="who-am-i" className={cn('flex items-center gap-2 text-xs text-muted-foreground', className)}>
      <UserRound className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1">{note}</span>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event(OPEN_SETTINGS_PROFILES_EVENT))}
        className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
      >
        選你是誰
      </button>
    </div>
  );
}
