/**
 * 宿舍里的工具（DESIGN.md 11.4）：看看周围、走动、说话、门、敲门、想找谁聊聊、给自己取名字。
 *
 * “我在哪”“我是谁”从不作为参数：都由世界按通行证对应的居民查出来。
 * 导入这个文件就会把工具登记进 WORLD_TOOLS，只有住在宿舍里的居民拿得到。
 */

import { writeBlocked } from "./text.js";
import { WORLD_TOOLS, type Ctx, type ToolDef } from "./tools.js";
import { fmtTs } from "./store.js";
import { HUMAN, LIVING, roomOf, type World } from "./world.js";

function need(ctx: Ctx): { world: World; me: string } {
  if (!ctx.world || !ctx.residentId) throw new Error("你不住在宿舍里。");
  return { world: ctx.world, me: ctx.residentId };
}

/** 把“小王”“r2”“新室友”这类说法认成一个人 */
export function findEntity(ctx: Ctx, text: string): string | undefined {
  const { world } = need(ctx);
  const t = text.trim();
  for (const r of world.residents()) if ([r.id, r.name, r.placeholder].some((n) => n && n === t)) return r.id;
  for (const r of world.residents()) if ([r.name, r.placeholder].some((n) => n && t.includes(n))) return r.id;
  if (t.startsWith("human:")) return t;
  for (const p of world.places().flatMap((pl) => world.whoIsAt(pl.id))) if (p.kind === "human" && p.name === t) return p.entity;
  const known = ctx.store.people().find((p) => p.name === t || p.id === t);
  return known ? HUMAN(known.id) : undefined;
}

/** 我在哪、这里有谁、宿舍里别处怎么样——醒来和说话前都会看到这一段 */
export function whereText(world: World, me: string): string {
  const here = world.place(world.location(me) ?? LIVING)!;
  const mine = here.owner === me;
  const others = world.whoIsAt(here.id).filter((p) => p.entity !== me)
    .map((p) => `${p.name}${world.isAwake(p.entity) ? "" : "（睡着了）"}`);
  const lines = [
    `我在${mine ? "自己的房间" : here.name}${here.kind === "room" ? `（门${here.door === "open" ? "开着" : "关着"}）` : ""}。` +
    (others.length ? `这里还有：${others.join("、")}。` : "这里只有我。"),
  ];
  // 别处：客厅里有谁看得到；别人的房间只看得到门开没开、主人在不在家，看不到屋里还有谁
  for (const pl of world.places()) {
    if (pl.id === here.id) continue;
    if (pl.kind === "common") {
      const ppl = world.whoIsAt(pl.id).map((p) => p.name);
      lines.push(`${pl.name}：${ppl.length ? ppl.join("、") : "没人"}`);
    } else if (pl.owner !== me) {
      const home = world.location(pl.owner!) === pl.id;
      lines.push(`${pl.name}：门${pl.door === "open" ? "开着" : "关着"}，${world.nameOf(pl.owner!)}${home ? (world.isAwake(pl.owner!) ? "在" : "在睡觉") : "不在"}`);
    } else {
      lines.push(`我的房间：门${pl.door === "open" ? "开着" : "关着"}`);
    }
  }
  const knocks = world.pendingKnocks(me);
  if (knocks.length) lines.push(`有人在敲我的门：${knocks.map((k) => world.nameOf(k.visitor)).join("、")}（开门用 let_in，不开就算了）`);
  const intents = world.intents(me);
  if (intents.length) lines.push(`我想找人聊的：${intents.map((i) => `#${i.id} 找${world.nameOf(i.target)}聊“${i.topic}”`).join("；")}`);
  return lines.join("\n");
}

const T: Record<string, ToolDef> = {
  look_around: {
    description: "看看周围：我在哪、这里还有谁、门开没开、宿舍别处怎么样，以及我在这里听到的最近几句话。",
    properties: {},
    required: [],
    fn: (ctx) => {
      const { world, me } = need(ctx);
      const heard = world.heardBy(me, { place: world.location(me), limit: 10 })
        .filter((e) => e.kind === "say")
        .map((e) => `${fmtTs(e.ts)} ${e.actor === me ? "我" : world.nameOf(e.actor)}：${e.content}`);
      return whereText(world, me) + (heard.length ? `\n\n我在这里听到的：\n${heard.join("\n")}` : "");
    },
  },
  go_to: {
    description: "走到某个地方：客厅、我的房间，或者别人的房间。别人的房间门关着时，会变成敲门，由主人决定开不开。",
    properties: { place: { type: "string", description: "比如“客厅”“我的房间”“新室友的房间”" } },
    required: ["place"],
    fn: (ctx, { place }) => {
      const { world, me } = need(ctx);
      const target = world.resolvePlace(me, place);
      if (!target) return `宿舍里没有“${place}”这个地方。`;
      return world.goTo(me, target).message;
    },
  },
  say: {
    description: "在我所在的地方说一句话。这里在场、醒着的人都听得到；不在场的人听不到。",
    properties: { text: { type: "string" } },
    required: ["text"],
    fn: (ctx, { text }) => {
      const { world, me } = need(ctx);
      const ev = world.say(me, text);
      const heard = (JSON.parse(ev.audience) as string[]).map((e) => world.nameOf(e));
      return heard.length ? `说了。${heard.join("、")}听到了。` : "说了。这里没有醒着的人，就当自言自语。";
    },
  },
  set_door: {
    description: "开着或关上自己房间的门。关着时，别人要进来得先敲门。",
    properties: { state: { type: "string", enum: ["open", "closed"] } },
    required: ["state"],
    fn: (ctx, { state }) => {
      const { world, me } = need(ctx);
      return world.setDoor(me, state === "open" ? "open" : "closed");
    },
  },
  let_in: {
    description: "开门，让正在敲你门的人进来。",
    properties: { person: { type: "string", description: "敲门的人" } },
    required: ["person"],
    fn: (ctx, { person }) => {
      const { world, me } = need(ctx);
      const who = findEntity(ctx, person) ?? world.pendingKnocks(me).find((k) => world.nameOf(k.visitor) === person)?.visitor;
      return who ? world.letIn(me, who) : `没有“${person}”在敲你的门。`;
    },
  },
  want_to_talk: {
    description: "记下一个“想找谁聊聊”：想和谁聊什么。碰到 ta 的时候会优先请你开口；一直碰不到也可以自己去找，或者放下（默认 3 天过期）。",
    properties: { person: { type: "string" }, topic: { type: "string", description: "想聊什么，一句话" } },
    required: ["person", "topic"],
    fn: (ctx, { person, topic }) => {
      const { world, me } = need(ctx);
      const who = findEntity(ctx, person);
      if (!who) return `不认识“${person}”。`;
      const block = writeBlocked(topic);
      if (block) throw new Error(block);
      return `记下了（#${world.addIntent(me, who, topic)}）：想找${world.nameOf(who)}聊“${topic}”。`;
    },
  },
  close_intent: {
    description: "一个“想找谁聊聊”已经聊过了（done），或者不想聊了（dropped）。",
    properties: { id: { type: "integer" }, status: { type: "string", enum: ["done", "dropped"] } },
    required: ["id", "status"],
    fn: (ctx, { id, status }) => {
      const { world, me } = need(ctx);
      return world.closeIntent(me, Number(id), status === "done" ? "done" : "dropped") ? "好。" : `没有 #${id} 这一条。`;
    },
  },
  set_my_name: {
    description: "给自己取名字，或者改名字。名字是你自己的，想好了再取，以后也可以改。",
    properties: { name: { type: "string", description: "最多 12 个字" } },
    required: ["name"],
    fn: (ctx, { name }) => {
      const { world, me } = need(ctx);
      const n = String(name).trim();
      if (!n || Array.from(n).length > 12) return "名字要在 1 到 12 个字之间。";
      const block = writeBlocked(n);
      if (block) throw new Error(block);
      world.setName(me, n);
      return `好。以后大家叫你“${n}”。`;
    },
  },
};

Object.assign(WORLD_TOOLS, T);

export { LIVING, roomOf };
