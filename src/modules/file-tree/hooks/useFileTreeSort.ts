import { useCallback, useState } from 'react';

import type { FileTreeSort, FileTreeSortKey } from '@/modules/file-tree/utils/fileTreeUtils';

const FILE_TREE_SORT_STORAGE_KEY = 'file-tree-sort';

const FILE_TREE_DEFAULT_SORT: FileTreeSort = { key: 'name', desc: false };

function readStoredSort(): FileTreeSort {
  try {
    const saved = JSON.parse(localStorage.getItem(FILE_TREE_SORT_STORAGE_KEY) ?? 'null');
    if (saved && (saved.key === 'name' || saved.key === 'modified')) {
      return { key: saved.key, desc: Boolean(saved.desc) };
    }
  } catch {
    // Keep default sort when storage is unavailable or corrupt.
  }
  return FILE_TREE_DEFAULT_SORT;
}

export function useFileTreeSort() {
  const [sort, setSort] = useState<FileTreeSort>(readStoredSort);

  // Same key flips direction; a new key starts newest-first for time, A→Z for name.
  const changeSort = useCallback((key: FileTreeSortKey) => {
    setSort((current) => {
      const next = current.key === key ? { key, desc: !current.desc } : { key, desc: key === 'modified' };
      try {
        localStorage.setItem(FILE_TREE_SORT_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Keep runtime state even when persistence fails.
      }
      return next;
    });
  }, []);

  return { sort, changeSort };
}
