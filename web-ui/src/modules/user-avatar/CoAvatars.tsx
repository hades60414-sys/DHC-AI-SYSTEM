import { coSessionParticipants, useCoPeople, type CoPerson, type CoSession } from '@/shared/coSessions';
import { cn } from '@/shared/utils';
import { AnimalAvatarImage } from '@/modules/user-avatar/UserAvatar';

/** One person's face: their profile's avatar, or the first letter of their name until they pick one. */
export function PersonAvatar({ person, className }: { person: CoPerson; className?: string }) {
  if (person.avatarId) {
    return <AnimalAvatarImage avatarId={person.avatarId} className={className} />;
  }
  return (
    <span
      role="img"
      aria-label={person.name}
      className={cn('flex items-center justify-center rounded-full bg-blue-600 text-[10px] font-medium leading-none text-white', className)}
    >
      {Array.from(person.name.trim())[0] ?? 'U'}
    </span>
  );
}

const MAX_STACKED = 3;
/** Someone whose project this browser cannot see (archived or removed). */
const UNKNOWN_PERSON: CoPerson = { name: '?', avatarId: null };

/** The people in a shared session, overlapped; it stands where the model logo is for an unshared session. */
export function CoAvatarStack({ session, className }: { session: CoSession; className?: string }) {
  const people = useCoPeople();
  const participants = coSessionParticipants(session).map((projectId) => (
    people.get(projectId) ?? UNKNOWN_PERSON
  ));
  const shown = participants.slice(0, MAX_STACKED);
  const hiddenCount = participants.length - shown.length;
  const names = participants.map((person) => person.name).join('、');

  return (
    <span className={cn('flex items-center', className)} title={`共享：${names}`} aria-label={`共享：${names}`}>
      {shown.map((person, index) => (
        <PersonAvatar
          key={index}
          person={person}
          className={cn('h-4 w-4 shrink-0 ring-1 ring-background', index > 0 && '-ml-1.5')}
        />
      ))}
      {hiddenCount > 0 && <span className="ml-0.5 text-[10px] leading-none text-muted-foreground">+{hiddenCount}</span>}
    </span>
  );
}
