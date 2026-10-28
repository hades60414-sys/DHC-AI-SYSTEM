import { useState } from 'react';
import { Check } from 'lucide-react';

import { Dialog, DialogContent, DialogTitle } from '@/shared/ui';
import { ANIMAL_AVATARS, findAnimalAvatar } from '@/shared/animalAvatars';
import { setUserAvatar, useUserAvatar } from '@/shared/userAvatars';
import { readActiveSettingsProfile } from '@/shared/userSettings';
import { cn } from '@/shared/utils';

/** One avatar drawn at the box size; the markup is our own static SVG (src/shared/animalAvatars.ts). */
export function AnimalAvatarImage({ avatarId, className }: { avatarId: string; className?: string }) {
  const avatar = findAnimalAvatar(avatarId);
  if (!avatar) return null;
  return (
    <svg
      viewBox="0 0 64 64"
      className={cn('block rounded-full', className)}
      role="img"
      aria-label={avatar.name}
      dangerouslySetInnerHTML={{ __html: avatar.body }}
    />
  );
}

/** This profile's face, or the original blue 「U」 until one is picked. */
export function UserAvatarFace({ className }: { className?: string }) {
  const avatarId = useUserAvatar();
  if (avatarId && findAnimalAvatar(avatarId)) {
    return <AnimalAvatarImage avatarId={avatarId} className={className} />;
  }
  return (
    <span className={cn('flex items-center justify-center rounded-full bg-blue-600 text-sm text-white', className)}>U</span>
  );
}

const STYLES = Array.from(new Set(ANIMAL_AVATARS.map((avatar) => avatar.style)));

type AvatarPickerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profileName?: string;
};

/** The 選頭像 page: every avatar grouped by style, plus going back to 「U」. A pick saves and closes. */
export function AvatarPickerDialog({ open, onOpenChange, profileName }: AvatarPickerDialogProps) {
  const current = useUserAvatar();
  const choose = (avatarId: string | null) => {
    setUserAvatar(avatarId);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto p-5">
        <DialogTitle>選頭像</DialogTitle>
        <div className="mb-4 flex items-center gap-3">
          <UserAvatarFace className="h-11 w-11 shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">選頭像{profileName ? `・${profileName}` : ''}</div>
            <div className="text-xs text-muted-foreground">綁在這台裝置的專案設定，切換專案設定頭像就跟著換。</div>
          </div>
        </div>
        <div className="space-y-4">
          {STYLES.map((style) => (
            <section key={style}>
              <h3 className="mb-2 text-xs font-medium tracking-wider text-muted-foreground">{style}</h3>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                {ANIMAL_AVATARS.filter((avatar) => avatar.style === style).map((avatar) => {
                  const selected = avatar.id === current;
                  return (
                    <button
                      key={avatar.id}
                      type="button"
                      onClick={() => choose(avatar.id)}
                      aria-pressed={selected}
                      title={avatar.name}
                      className={cn(
                        'group relative flex flex-col items-center gap-1 rounded-xl p-2 transition-colors hover:bg-accent',
                        selected && 'bg-accent ring-2 ring-primary',
                      )}
                    >
                      <AnimalAvatarImage
                        avatarId={avatar.id}
                        className="h-12 w-12 transition-transform duration-150 group-hover:scale-105"
                      />
                      <span className="text-[11px] text-muted-foreground">{avatar.name}</span>
                      {selected && (
                        <Check className="absolute right-1 top-1 h-3.5 w-3.5 rounded-full bg-primary p-0.5 text-primary-foreground" />
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
        <div className="mt-5 flex justify-between gap-2 border-t pt-3">
          <button
            type="button"
            onClick={() => choose(null)}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            恢復預設「U」
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md px-3 py-1.5 text-sm hover:bg-accent"
          >
            關閉
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The avatar beside a user message: click it to change this profile's face. */
export function UserAvatarButton({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="換頭像"
        aria-label="換頭像"
        className={cn('rounded-full transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}
      >
        <UserAvatarFace className="h-full w-full" />
      </button>
      {open && (
        <AvatarPickerDialog open={open} onOpenChange={setOpen} profileName={readActiveSettingsProfile()?.name} />
      )}
    </>
  );
}
