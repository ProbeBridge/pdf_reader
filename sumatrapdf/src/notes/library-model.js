export function libraryKey(path, windows = navigator.platform.startsWith("Win")) {
  const normalized = windows ? path.replaceAll("\\", "/").toLowerCase() : path;
  return `library:${normalized}`;
}

export function libraryEntries(records, query = "") {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return (Array.isArray(records) ? records : [])
    .filter(
      (entry) =>
        typeof entry?.key === "string" &&
        entry.key.startsWith("library:") &&
        typeof entry.book?.path === "string" &&
        typeof entry.book?.name === "string",
    )
    .filter(({ book }) => words.every((word) => `${book.name} ${book.path}`.toLocaleLowerCase().includes(word)))
    .sort(
      (a, b) => (Number(b.book.addedAt) || 0) - (Number(a.book.addedAt) || 0) || a.book.name.localeCompare(b.book.name),
    );
}
