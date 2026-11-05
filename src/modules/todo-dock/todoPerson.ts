import { useMemo, useSyncExternalStore } from 'react';

import { isQueryProject, isWorkspaceProject } from '@/modules/sidebar';
import { isFlashProject } from '@/shared/flashTasks';
import type { Project } from '@/shared/types';
import { resolveSettingsProjectId } from '@/shared/userSettings';

const PERSON_STORAGE_KEY = 'dhc.todosPerson';

const readStored = () => {
  try {
    return localStorage.getItem(PERSON_STORAGE_KEY);
  } catch {
    return null;
  }
};

// One choice shared by 待辦 and 行事曆, so switching person in one switches the other.
let chosenId: string | null = readStored();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const choosePerson = (projectId: string) => {
  chosenId = projectId;
  try {
    localStorage.setItem(PERSON_STORAGE_KEY, projectId);
  } catch {
    // Storage blocked: the choice lasts for this page load.
  }
  listeners.forEach((listener) => listener());
};

/** Whose to-dos are shown: one list per person (workspace project), opening on this device's own person. */
export function useTodoPerson(projects: Project[]) {
  const people = useMemo(
    () => projects.filter((project) => isWorkspaceProject(project) && !isQueryProject(project) && !isFlashProject(project)),
    [projects],
  );
  const chosen = useSyncExternalStore(subscribe, () => chosenId, () => null);
  const pick = (ids: (string | null | undefined)[]) =>
    ids.find((id) => id && people.some((project) => project.projectId === id)) ?? null;
  const ownId = pick([resolveSettingsProjectId(people), people[0]?.projectId]);
  const personId = pick([chosen, ownId]);
  // 11/01: the dock always shows ownId (its switcher is gone for privacy); 行事曆 still switches with personId.
  return { people, personId, ownId, choosePerson };
}
