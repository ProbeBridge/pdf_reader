import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  readingSummary,
  readingSeries,
} from "../sumatrapdf/src/notes/reading-stats-model.js";

const now = new Date("2026-11-12T12:00:00").getTime();
const data = {
  "stats:reading:a": {
    kind: "reading",
    day: "2026-11-12",
    document: "a",
    pages: [1, 2, 2, 0, -1, 4],
    pageCount: 3,
    seconds: 60,
  },
  "stats:reading:a-copy": {
    kind: "reading",
    day: "2026-11-12",
    document: "a",
    pages: [2, 3],
    pageCount: 3,
    seconds: 90,
  },
  "stats:reading:b": {
    kind: "reading",
    day: "2026-11-12",
    document: "b",
    pages: [1],
    seconds: 35,
  },
  "stats:words:today": {
    kind: "vocabulary",
    day: "2026-11-12",
    ids: ["one", "two", "two", ""],
  },
  "stats:words:copy": {
    kind: "vocabulary",
    day: "2026-11-12",
    ids: ["two", "three"],
  },
  "stats:reading:previous": {
    kind: "reading",
    day: "2026-11-11",
    document: "a",
    pages: [1, 1],
    seconds: 10,
  },
  "stats:words:previous": {
    kind: "vocabulary",
    day: "2026-11-11",
    ids: ["yesterday"],
  },
  "page:imported": { annotations: [{ id: "old-note", createdAt: now }] },
  "stats:words:future": {
    kind: "vocabulary",
    day: "2026-11-13",
    ids: ["future"],
  },
  "stats:words:old": { kind: "vocabulary", day: "2020-01-01", ids: ["old"] },
};
const summary = readingSummary(data, 7, now);
assert.deepEqual(summary.today, {
  day: "2026-11-12",
  pages: 4,
  words: 3,
  seconds: 125,
});
assert.deepEqual(summary.totals, { pages: 5, words: 4, seconds: 135 });
assert.equal(summary.days.length, 7);
assert.equal(summary.days[0].day, "2026-11-06");
assert.equal(summary.days[0].pages, 0);
assert.equal(
  summary.days[5].pages,
  1,
  "the same page counts again on another day",
);
assert.deepEqual(readingSummary({}, 14, now).totals, {
  pages: 0,
  words: 0,
  seconds: 0,
});
assert.equal(readingSummary(null, 100000, now).days.length, 90);
assert.equal(
  readingSummary(
    {
      "stats:bad": {
        kind: "reading",
        day: "2026-11-12",
        document: "bad",
        pages: "broken",
        seconds: -20,
      },
    },
    1,
    now,
  ).today.seconds,
  0,
);
const calendar = {};
for (const [day, pages, seconds, ids] of [
  ["2024-02-29", [1], 10, ["leap"]],
  ["2025-12-28", [1], 30, ["sunday"]],
  ["2025-12-29", [1, 2], 120, ["monday", "two"]],
  ["2025-12-31", [2], 60, ["year-end"]],
  ["2026-01-01", [1, 2, 3], 180, ["new-year"]],
  ["2026-01-02", [4], 240, ["today"]],
  ["2026-01-03", [5], 999, ["future"]],
]) {
  calendar[`stats:reading:${day}`] = {
    kind: "reading",
    day,
    document: "calendar",
    pages,
    seconds,
  };
  calendar[`stats:words:${day}`] = { kind: "vocabulary", day, ids };
}
const calendarNow = new Date("2026-01-02T12:00:00").getTime();
const metricValues = (point) => [point.pages, point.annotations, point.seconds];
const daily = readingSeries(calendar, "day", calendarNow);
assert.equal(daily.points.length, 14);
assert.deepEqual(metricValues(daily.current), [1, 1, 240]);
const weekly = readingSeries(calendar, "week", calendarNow);
assert.equal(weekly.points.length, 12);
assert.equal(weekly.current.start, "2025-12-29");
assert.equal(weekly.current.end, "2026-01-04");
assert.deepEqual(metricValues(weekly.current), [7, 5, 600]);
assert.deepEqual(metricValues(weekly.points.at(-2)), [1, 1, 30]);
const monthly = readingSeries(calendar, "month", calendarNow);
assert.equal(monthly.points.length, 12);
assert.equal(monthly.current.start, "2026-01-01");
assert.deepEqual(metricValues(monthly.current), [4, 2, 420]);
const yearly = readingSeries(calendar, "year", calendarNow);
assert.equal(yearly.points.length, 5);
assert.deepEqual(metricValues(yearly.current), [4, 2, 420]);
assert.deepEqual(
  metricValues(yearly.points.find((point) => point.start === "2024-01-01")),
  [1, 1, 10],
);
assert.deepEqual(metricValues(yearly.totals), [9, 7, 640]);
assert.equal(readingSeries({}, "invalid", calendarNow).period, "day");
for (const timezone of [
  "America/Los_Angeles",
  "Europe/Berlin",
  "Asia/Shanghai",
]) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { readingSummary, readingSeries } from './sumatrapdf/src/notes/reading-stats-model.js';
    for (const date of ['2026-03-10T12:00:00', '2026-11-03T12:00:00', '2024-03-02T12:00:00']) {
      const summary = readingSummary({}, 14, new Date(date).getTime());
      assert.equal(new Set(summary.days.map(day => day.day)).size, 14);
      assert.equal(summary.today.day, date.slice(0, 10));
      for (const period of ['day', 'week', 'month', 'year']) {
        const series = readingSeries({}, period, new Date(date).getTime());
        assert.equal(new Set(series.points.map(point => point.start)).size, series.points.length);
        assert.ok(series.current.start <= date.slice(0, 10));
        assert.ok(series.current.end >= date.slice(0, 10));
      }
    }
  `,
    ],
    { env: { ...process.env, TZ: timezone }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${timezone}: ${result.stderr}`);
}
console.log(
  "PASS: daily deduplication; day/week/month/year totals; year boundaries; Monday weeks; future filtering; DST and leap days.",
);
