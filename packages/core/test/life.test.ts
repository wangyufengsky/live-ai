/** 生活循环、感知层、称呼、短期记忆溢出、记忆的来历。大脑是假的，不花钱。 */

import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

const thoughts: { channel: string; prompt: string }[] = [];
vi.mock("../src/brains/index.js", () => ({
  think: vi.fn(async (ctx: { channel: string }, prompt: string) => {
    thoughts.push({ channel: ctx.channel, prompt });
    return `回复${thoughts.length}`;
  }),
}));

import { config } from "../src/config.js";
import { today } from "../src/energy.js";
import * as life from "../src/life.js";
import { perceive } from "../src/perception.js";
import type { Store } from "../src/store.js";
import { makeCtx, runTool } from "../src/tools.js";
import { freshStore } from "./helpers.js";

let store: Store;
const logs: string[] = [];
const log = (l: string) => logs.push(l);
const lastThought = () => thoughts[thoughts.length - 1];

beforeAll(() => {
  store = freshStore();
  config.sleepHour = 0;
  config.quietHours = [0, 0];
  store.put("last_sleep_date", today());
  store.put("next_wake", Date.now() / 1000 + 3600);
});

describe("生活", () => {
  it("感知层：书架多了、少了，新的一天；没变化就不说话", () => {
    fs.writeFileSync(path.join(config.booksDir, "a.txt"), "甲");
    perceive(store);
    fs.writeFileSync(path.join(config.booksDir, "b.txt"), "乙");
    fs.unlinkSync(path.join(config.booksDir, "a.txt"));
    store.put("last_seen_date", "2000-01-01");
    const noticed = perceive(store);
    expect(noticed.slice(0, 2)).toEqual(["书架上多了一本书：b.txt", "书架上少了一本书：a.txt"]);
    expect(noticed[2]).toMatch(/^新的一天/);
    expect(perceive(store)).toEqual([]);
  });

  it("收件箱：同一个人连发的合并，一个人一个人地回；回复不算主动找人", async () => {
    store.pushInbox("dm:me", "me", "小王", "在吗");
    store.pushInbox("dm:me", "me", "小王", "今天好累");
    store.pushInbox("dm:x", "x", "小李", "你好");
    expect(await life.step(store, log)).toBe(true);
    expect(thoughts).toHaveLength(2);
    expect(thoughts[0].channel).toBe("dm:me");
    expect(thoughts[0].prompt).toContain("在吗\n今天好累");
    expect(thoughts[0].prompt).toContain("称呼：ta（对方没说过，不要猜）");
    expect(store.takeOutbox("me").map((r) => [r.kind, r.content])).toEqual([["reply", "回复1"]]);
    expect(store.sentToday("me")).toBe(0);
  });

  it("先回人，再做自己的事；醒过之后排好下一次", async () => {
    store.put("next_wake", 0);
    store.pushInbox("dm:me", "me", "小王", "晚安");
    await life.step(store, log);
    expect(lastThought().channel).toBe("dm:me");
    await life.step(store, log);
    expect(lastThought().channel).toBe("self");
    expect(lastThought().prompt).toContain("现在没有人找你");
    expect(Number(store.get("next_wake"))).toBeGreaterThan(Date.now() / 1000);
    expect(await life.step(store, log)).toBe(false);
  });

  it("深夜不醒，但会排下一次", async () => {
    config.quietHours = [0, 24];
    store.put("next_wake", 0);
    const n = thoughts.length;
    expect(await life.step(store, log)).toBe(false);
    expect(thoughts).toHaveLength(n);
    expect(Number(store.get("next_wake"))).toBeGreaterThan(Date.now() / 1000);
    config.quietHours = [0, 0];
  });

  it("称呼：对方说过才记，没说过的用 ta", async () => {
    const [out] = await runTool(makeCtx(store, "dm:me"), "set_pronoun", { person_id: "me", pronoun: "他" });
    expect(out).toBe("记住了，以后用“他”。");
    expect(life.fmtPeople(store)).toContain("称呼：他");
    expect(life.fmtPeople(store)).toContain("称呼：ta（对方没说过，不要猜）");
  });

  it("记忆都是她的：私聊里记的在群里也想得起来，并且带着来历", async () => {
    await runTool(makeCtx(store, "dm:me"), "remember", { content: "小王说最近工作很累", about: "me" });
    const [inGroup] = await runTool(makeCtx(store, "group:1"), "search_memory", { query: "工作" });
    expect(inGroup).toContain("小王说最近工作很累");
    expect(inGroup).toContain("（小王私下跟我说的）");
    const [publicOne] = await runTool(makeCtx(store), "search_memory", { query: "不存在的事" });
    expect(publicOne).toBe("没想起什么相关的。");
  });

  it("短期记忆溢出：快满时提醒，掉出眼前的可以翻看，翻过就算整理过", async () => {
    config.recentEvents = 10;
    store.markSorted(store.maxEventId());
    for (let i = 0; i < 8; i++) store.log("thought", `想法${i}`);
    expect(life.overflowNote(store)).toContain("再不整理");
    for (let i = 8; i < 20; i++) store.log("thought", `想法${i}`);
    expect(life.overflowNote(store)).toContain("10 件更早的事没整理");
    const [out] = await runTool(makeCtx(store), "review_unsorted", {});
    expect(out).toContain("想法0");
    expect(out).toContain("想法9");
    expect(out).not.toContain("想法10");
    expect(life.overflowNote(store)).not.toContain("更早的事");
    store.put("next_wake", 0);
    await life.step(store, log);
    expect(lastThought().prompt).toContain("【提醒】");
  });

  it("睡觉后，今天的事都算整理过了", async () => {
    store.put("last_sleep_date", "2000-01-01");
    await life.step(store, log);
    expect(lastThought().prompt).toContain("该睡觉了");
    expect(store.unsortedCount()).toBeLessThanOrEqual(1);
    expect(life.overflowNote(store)).toBe("");
  });

  it("本地聊天：有 run 在跑时走收件箱", () => {
    expect(life.isAlive(store)).toBe(true);
    store.put("alive_at", 0);
    expect(life.isAlive(store)).toBe(false);
  });
});
