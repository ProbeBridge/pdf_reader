import { dayKey } from "./history-model.js";

function dailyRecords(records, first, last) {
  const byDay = new Map();
  for (const [key, record] of Object.entries(records || {})) {
    if (!key.startsWith("stats:") || !record || typeof record !== "object") continue;
    const date = record.day;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < first || date > last) continue;
    if (dayKey(new Date(`${date}T12:00:00`).getTime()) !== date) continue;
    let day = byDay.get(date);
    if (!day) byDay.set(date, (day = { day: date, documents: new Map(), ids: new Set() }));
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
  return new Map(
    [...byDay.values()].map((item) => [
      item.day,
      {
        day: item.day,
        pages: [...item.documents.values()].reduce((sum, doc) => sum + doc.pages.size, 0),
        words: item.ids.size,
        seconds: [...item.documents.values()].reduce((sum, doc) => sum + doc.seconds, 0),
      },
    ]),
  );
}

export function readingSummary(records, count = 14, now = Date.now()) {
  count = Math.min(90, Math.max(1, Math.floor(Number(count) || 14)));
  const keys = [];
  for (let offset = count - 1; offset >= 0; offset--) {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    keys.push(dayKey(date.getTime()));
  }
  const data = dailyRecords(records, keys[0], keys.at(-1));
  const daily = keys.map((day) => data.get(day) || { day, pages: 0, words: 0, seconds: 0 });
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

const windows = { day: 14, week: 12, month: 12, year: 5 };

function periodStart(value, period) {
  const date = new Date(value);
  date.setHours(12, 0, 0, 0);
  if (period === "week") date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); // Monday.
  if (period === "month") date.setDate(1);
  if (period === "year") date.setMonth(0, 1);
  return date;
}

function shiftPeriod(value, period, offset) {
  const date = new Date(value);
  if (period === "year") date.setFullYear(date.getFullYear() + offset);
  else if (period === "month") date.setMonth(date.getMonth() + offset);
  else date.setDate(date.getDate() + offset * (period === "week" ? 7 : 1));
  return date;
}

/** Sum daily measurements into local calendar periods, preserving daily page/note deduplication. */
export function readingSeries(records, period = "day", now = Date.now()) {
  if (!Object.hasOwn(windows, period)) period = "day";
  const currentStart = periodStart(now, period);
  const points = [];
  for (let offset = windows[period] - 1; offset >= 0; offset--) {
    const start = shiftPeriod(currentStart, period, -offset);
    const end = shiftPeriod(start, period, 1);
    end.setDate(end.getDate() - 1);
    points.push({ start: dayKey(start.getTime()), end: dayKey(end.getTime()), pages: 0, annotations: 0, seconds: 0 });
  }
  const byStart = new Map(points.map((point) => [point.start, point]));
  const data = dailyRecords(records, points[0].start, dayKey(now));
  for (const daily of data.values()) {
    const key = dayKey(periodStart(new Date(`${daily.day}T12:00:00`), period).getTime());
    const point = byStart.get(key);
    if (!point) continue;
    point.pages += daily.pages;
    point.annotations += daily.words;
    point.seconds += daily.seconds;
  }
  return {
    period,
    points,
    current: points.at(-1),
    totals: points.reduce(
      (sum, point) => ({
        pages: sum.pages + point.pages,
        annotations: sum.annotations + point.annotations,
        seconds: sum.seconds + point.seconds,
      }),
      { pages: 0, annotations: 0, seconds: 0 },
    ),
  };
}
