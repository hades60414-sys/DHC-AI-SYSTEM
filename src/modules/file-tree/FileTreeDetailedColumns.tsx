import { ArrowDown, ArrowUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FileTreeSort, FileTreeSortKey } from '@/modules/file-tree/utils/fileTreeUtils';

type FileTreeDetailedColumnsProps = {
  sort: FileTreeSort;
  onSortChange: (key: FileTreeSortKey) => void;
};

/** Rendered by FileTree in detailed view mode to label the name/size/modified/permissions columns; name and modified sort on click. */
export default function FileTreeDetailedColumns({ sort, onSortChange }: FileTreeDetailedColumnsProps) {
  const { t } = useTranslation();

  const sortButton = (key: FileTreeSortKey, label: string, span: string) => {
    const Arrow = sort.desc ? ArrowDown : ArrowUp;
    return (
      <button
        type="button"
        onClick={() => onSortChange(key)}
        className={`${span} flex items-center gap-0.5 text-left uppercase tracking-wider hover:text-foreground ${sort.key === key ? 'text-foreground' : ''}`}
      >
        {label}
        {sort.key === key && <Arrow className="h-3 w-3" />}
      </button>
    );
  };

  return (
    <div className="border-b border-border px-3 pb-1 pt-1.5">
      <div className="grid grid-cols-12 gap-2 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {sortButton('name', t('fileTree.name'), 'col-span-5')}
        <div className="col-span-2">{t('fileTree.size')}</div>
        {sortButton('modified', t('fileTree.modified'), 'col-span-3')}
        <div className="col-span-2">{t('fileTree.permissions')}</div>
      </div>
    </div>
  );
}
