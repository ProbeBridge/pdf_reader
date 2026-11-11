export function dayKey(ms) {
  if (!ms || !Number.isFinite(Number(ms))) return "";
  const d = new Date(Number(ms));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function historyGroups(entries, query = "") {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = entries
    .filter((e) => words.every((w) => `${e.name} ${e.path}`.toLocaleLowerCase().includes(w)))
    .sort((a, b) => (b.opened || 0) - (a.opened || 0));
  const groups = new Map();
  for (const entry of filtered) {
    const day = dayKey(entry.opened);
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(entry);
  }
  return [...groups].map(([day, files]) => ({ day, files }));
}
