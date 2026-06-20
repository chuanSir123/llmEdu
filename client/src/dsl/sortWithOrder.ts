export function sortWithOrder<T extends { sortOrder?: number }>(items: T[]): T[] {
  if (!items.length) return items;
  const hasSortOrder = items.some((item) => item.sortOrder != null && item.sortOrder >= 0);
  if (!hasSortOrder) return items;
  return [...items].sort((a, b) => {
    const aOrder = a.sortOrder != null && a.sortOrder >= 0 ? a.sortOrder : Number.MAX_SAFE_INTEGER;
    const bOrder = b.sortOrder != null && b.sortOrder >= 0 ? b.sortOrder : Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder;
  });
}