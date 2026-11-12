import { dayKey } from "./history-model.js";

export function readingSummary(records, count = 14, now = Date.now()) {
  count = Math.min(90, Math.max(1, Math.floor(Number(count) || 14)));
  const days = [],
    byDay = new Map();
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const day = dayKey(date.getTime());
    const item = { day, pages: 0, words: 0, seconds: 0, documents: new Map(), ids: new Set() };
    days.push(item);
    byDay.set(day, item);
  }
  for (const [key, record] of Object.entries(records || {})) {
    if (!key.startsWith("stats:") || !record || typeof record !== "object") continue;
    const day = byDay.get(record.day);
    if (!day) continue;
    if (record.kind === "reading" && typeof record.document === "string" && record.document) {
      let doc = day.documents.get(record.document);
      if (!doc) day.documents.set(record.document, (doc = { pages: new Set(), seconds: 0 }));
      for (const page of Array.isArray(record.pages) ? record.pages : [])
        if (Number.isInteger(page) && page > 0 && (!record.pageCount || page <= record.pageCount)) doc.pages.add(page);
      const seconds = Number(record.seconds);
      if (Number.isFinite(seconds))
        doc.seconds = Math.max(doc.seconds, Math.min(90000, Math.max(0, Math.floor(seconds))));
    } else if (record.kind === "vocabulary") {
      for (const id of Array.isArray(record.ids) ? record.ids : []) if (typeof id === "string" && id) day.ids.add(id);
    }
  }
  const daily = days.map((item) => ({
    day: item.day,
    pages: [...item.documents.values()].reduce((sum, doc) => sum + doc.pages.size, 0),
    words: item.ids.size,
    seconds: [...item.documents.values()].reduce((sum, doc) => sum + doc.seconds, 0),
  }));
  return {
    days: daily,
    today: daily.at(-1),
    totals: daily.reduce(
      (sum, item) => ({
        pages: sum.pages + item.pages,
        words: sum.words + item.words,
        seconds: sum.seconds + item.seconds,
      }),
      { pages: 0, words: 0, seconds: 0 },
    ),
  };
}
