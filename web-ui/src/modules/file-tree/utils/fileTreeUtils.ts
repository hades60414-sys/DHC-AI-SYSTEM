import type { TFunction } from 'i18next';

import type { FileTreeNode } from '@/shared/types';

const IMAGE_FILE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'ico',
  'bmp',
]);

export function filterFileTree(items: FileTreeNode[], query: string): FileTreeNode[] {
  return items.reduce<FileTreeNode[]>((filteredItems, item) => {
    const matchesName = item.name.toLowerCase().includes(query);
    const filteredChildren =
      item.type === 'directory' && item.children ? filterFileTree(item.children, query) : [];

    if (matchesName || filteredChildren.length > 0) {
      filteredItems.push({
        ...item,
        children: filteredChildren,
      });
    }

    return filteredItems;
  }, []);
}

// During search we auto-expand every directory present in the filtered subtree.
export function collectExpandedDirectoryPaths(items: FileTreeNode[]): string[] {
  const paths: string[] = [];

  const visit = (nodes: FileTreeNode[]) => {
    nodes.forEach((node) => {
      if (node.type === 'directory' && node.children && node.children.length > 0) {
        paths.push(node.path);
        visit(node.children);
      }
    });
  };

  visit(items);
  return paths;
}

export function formatFileSize(bytes?: number): string {
  if (!bytes || bytes === 0) {
    return '0 B';
  }

  const base = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const index = Math.floor(Math.log(bytes) / Math.log(base));

  return `${(bytes / Math.pow(base, index)).toFixed(1).replace(/\.0$/, '')} ${sizes[index]}`;
}

export function formatRelativeTime(date: string | undefined, t: TFunction): string {
  if (!date) {
    return '-';
  }

  const now = new Date();
  const past = new Date(date);
  const diffInSeconds = Math.floor((now.getTime() - past.getTime()) / 1000);

  if (diffInSeconds < 60) {
    return t('fileTree.justNow');
  }

  if (diffInSeconds < 3600) {
    return t('fileTree.minAgo', { count: Math.floor(diffInSeconds / 60) });
  }

  if (diffInSeconds < 86400) {
    return t('fileTree.hoursAgo', { count: Math.floor(diffInSeconds / 3600) });
  }

  if (diffInSeconds < 2592000) {
    return t('fileTree.daysAgo', { count: Math.floor(diffInSeconds / 86400) });
  }

  return past.toLocaleDateString();
}

export function isImageFile(filename: string): boolean {
  const extension = filename.split('.').pop()?.toLowerCase();
  return Boolean(extension && IMAGE_FILE_EXTENSIONS.has(extension));
}


export type FileTreeSortKey = 'name' | 'modified';

export type FileTreeSort = {
  key: FileTreeSortKey;
  desc: boolean;
};

// Folders stay above files in every mode, like the server's default order.
export function sortFileTree(items: FileTreeNode[], sort: FileTreeSort): FileTreeNode[] {
  const direction = sort.desc ? -1 : 1;
  return [...items]
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'directory' ? -1 : 1;
      }
      if (sort.key === 'modified') {
        const diff = (Date.parse(left.modified ?? '') || 0) - (Date.parse(right.modified ?? '') || 0);
        if (diff !== 0) return diff * direction;
      }
      return left.name.localeCompare(right.name) * (sort.key === 'name' ? direction : 1);
    })
    .map((item) => (item.children ? { ...item, children: sortFileTree(item.children, sort) } : item));
}
