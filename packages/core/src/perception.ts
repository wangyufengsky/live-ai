/**
 * 感知层：把周围的变化变成她能“注意到”的事件。
 *
 * 每个感受器（sensor）是一个函数 (store) => string[]，返回这次新注意到的事，
 * 没有变化就返回空数组。它们会被频繁调用，所以要便宜，并且只在变化时说话。
 * 以后的网页订阅、某人很久没出现……都可以写成新的感受器加进 SENSORS。
 */

import fs from "node:fs";
import { config } from "./config.js";
import { today } from "./energy.js";
import type { Store } from "./store.js";

export const WEEKDAYS = "日一二三四五六"; // JS 的 getDay() 从星期日开始

export type Sensor = (store: Store) => string[];

export const bookshelf: Sensor = (store) => {
  const known = new Set((store.get("known_books") ?? "").split("\n").filter(Boolean));
  const books = new Set(fs.readdirSync(config.booksDir).filter((f) => f.endsWith(".txt") || f.endsWith(".md")));
  const added = [...books].filter((b) => !known.has(b)).sort();
  const removed = [...known].filter((b) => !books.has(b)).sort();
  if (!added.length && !removed.length) return [];
  store.put("known_books", [...books].sort().join("\n"));
  return [...added.map((b) => `书架上多了一本书：${b}`), ...removed.map((b) => `书架上少了一本书：${b}`)];
};

export const newDay: Sensor = (store) => {
  const last = store.get("last_seen_date");
  const t = today();
  if (last === t) return [];
  store.put("last_seen_date", t);
  const d = new Date();
  return last ? [`新的一天：${d.getMonth() + 1}月${d.getDate()}日，星期${WEEKDAYS[d.getDay()]}`] : [];
};

export const SENSORS: Sensor[] = [bookshelf, newDay];

export function perceive(store: Store): string[] {
  const noticed = SENSORS.flatMap((sensor) => sensor(store));
  for (const line of noticed) store.log("system", line);
  return noticed;
}
