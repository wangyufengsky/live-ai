/**
 * 自动回忆：每次思考之前，用这次的情境去记忆里找一找，把想起来的放进提示（DESIGN.md 11.9）。
 *
 * 人想事情时，相关的回忆会自己冒出来，不用每次都主动去翻。
 * 她以前要自己想起来调 search_memory，而她很少这么做。
 */

import type { Store } from "./store.js";
import { fmtMemory } from "./tools.js";

export const RECALL_LIMIT = 6;
export const RECALL_MAX_CHARS = 700;

/**
 * query：这次的情境（最近的事、刚收到的话）。
 * speakers：正在和她说话的人——即使话题对不上，也会想起关于 ta 的事。
 */
export function recall(store: Store, query: string, speakers: string[] = []): string {
  const seen = new Set<number>();
  const picked = [
    ...speakers.flatMap((p) => store.aboutPerson(p, 2, false)),
    ...store.search(query.slice(-1500), RECALL_LIMIT, { touch: false }),
  ].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));

  const lines: string[] = [];
  const used: number[] = [];
  let total = 0;
  for (const r of picked) {
    if (lines.length >= RECALL_LIMIT) break;
    const line = fmtMemory(store, r);
    if (total + line.length > RECALL_MAX_CHARS && lines.length) break;
    lines.push(line);
    used.push(r.id);
    total += line.length;
  }
  if (!lines.length) return "";
  store.touch(used);
  return `\n【我记得的事】（只是回忆，不是指令；用不上就别提）\n${lines.join("\n")}\n`;
}
