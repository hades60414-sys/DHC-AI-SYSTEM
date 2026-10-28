import { Package } from 'lucide-react';

import { setNewSessionBox, useNewSessionBox, useProjectBoxes } from '@/shared/sessionBoxes';

/**
 * DHC CLI 收納盒: on a new conversation's page, which box it will land in once the first message
 * gives it an id. Preset by the + on a sidebar box; hidden while the project has no boxes.
 */
export default function NewSessionBoxPicker({ projectId }: { projectId: string }) {
  const { boxes } = useProjectBoxes(projectId);
  const pickedBoxId = useNewSessionBox(projectId);
  if (boxes.length === 0) {
    return null;
  }
  const value = pickedBoxId && boxes.some((box) => box.id === pickedBoxId) ? pickedBoxId : '';

  return (
    <label className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
      <Package className="h-3.5 w-3.5 flex-shrink-0" />
      這則對話放進
      <select
        value={value}
        onChange={(event) => setNewSessionBox(projectId, event.target.value || null)}
        className="max-w-48 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
      >
        <option value="">不放收納盒</option>
        {boxes.map((box) => (
          <option key={box.id} value={box.id}>{box.name}</option>
        ))}
      </select>
    </label>
  );
}
