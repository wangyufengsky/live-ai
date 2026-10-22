/** 她的一天：醒来、和人聊天、睡觉。step / runForever 把这些串成一个持续的、由事件驱动的生活。 */

import { think } from "./brains/index.js";
import { config } from "./config.js";
import { Energy, today } from "./energy.js";
import { perceive, WEEKDAYS } from "./perception.js";
import { chatPrompt, sleepPrompt, wakePrompt } from "./prompts.js";
import { recall } from "./recall.js";
import { fmtTs, now, type EventRow, type PersonRow, type Store } from "./store.js";
import { makeCtx } from "./tools.js";

type Log = (line: string) => void;

const pad = (n: number) => String(n).padStart(2, "0");
export function nowText(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}，星期${WEEKDAYS[d.getDay()]}`;
}

const WHO: Record<string, string> = { heard: "", said: "我说", did: "我做了", thought: "我想", read: "我在读", system: "（注意到）" };

export function fmtEvents(rows: EventRow[]): string {
  if (!rows.length) return "（没什么）";
  return rows.map((r) => {
    const actor = r.kind === "heard" ? r.actor : WHO[r.kind] ?? r.kind;
    const where = r.channel === "self" ? "" : `[${r.channel}] `;
    return `${fmtTs(r.ts)} ${where}${actor}：${r.content}`;
  }).join("\n");
}

function fmtThreads(store: Store): string {
  const rows = store.threads(["active", "resting"]);
  return rows.length ? rows.map((r) => `#${r.id} [${r.status}] ${r.title} —— ${r.note}`).join("\n") : "（还没有）";
}

const pronoun = (p: PersonRow) => p.pronoun || "ta（对方没说过，不要猜）";

export function fmtPeople(store: Store): string {
  const rows = store.people();
  if (!rows.length) return "（还没认识谁）";
  return rows.map((r) =>
    `${r.name}（id=${r.id}，称呼：${pronoun(r)}，上次见 ${fmtTs(r.last_seen)}，` +
    `${r.dm_ok ? "可以主动找 ta" : "还没同意被主动私聊"}）：${r.notes || "（还没写印象）"}`).join("\n");
}

/** 短期记忆快装不下时提醒她。眼前只看得到最近 recentEvents 条，更早的没整理就会被忘掉 */
export function overflowNote(store: Store): string {
  const window = config.recentEvents;
  const lost = store.unsortedOutOfView(window).length;
  if (lost) return `\n【提醒】还有 ${lost} 件更早的事没整理，已经不在眼前了。想翻看的话用 review_unsorted，值得留下的记一下。`;
  if (store.unsortedCount() >= window * 0.75) return "\n【提醒】最近的事有点多了，再不整理，早一些的就要记不清了。";
  return "";
}

export async function wake(store: Store): Promise<string> {
  perceive(store);
  const energy = new Energy(store);
  if (energy.percent <= 5) {
    store.log("thought", "太累了，今天就先这样吧。");
    return "";
  }
  const last = store.get("last_wake");
  const sinceLast = last ? `上次醒来是 ${((now() - Number(last)) / 3600).toFixed(1)} 小时前。` : "";
  store.put("last_wake", now());

  const recent = store.recentEvents(config.recentEvents);
  // 用最近发生的事和挂着的线头去想起相关的回忆
  const context = [...recent.slice(-12).map((e) => e.content), ...store.threads(["active"]).map((t) => `${t.title} ${t.note}`)].join("\n");
  const prompt = wakePrompt({
    now: nowText(), sinceLast, energy: energy.percent, selfMd: store.readSelf(), threads: fmtThreads(store),
    events: fmtEvents(recent), people: fmtPeople(store), recall: recall(store, context), overflow: overflowNote(store),
  });
  const thought = await think(makeCtx(store), prompt, config.effortWake);
  if (thought) store.log("thought", thought);
  return thought;
}

/** 回应某个人。连着发来的几条消息会一起交给她，就像人看到一串消息再一起回 */
export async function chat(store: Store, personId: string, name: string, messages: string | string[]): Promise<string> {
  const texts = typeof messages === "string" ? [messages] : messages;
  perceive(store);
  store.seePerson(personId, name);
  const channel = `dm:${personId}`;
  for (const m of texts) store.log("heard", m, channel, name);

  const energy = new Energy(store);
  const p = store.person(personId)!;
  const history = store.recentEvents(20 + texts.length, { channel }).slice(0, -texts.length);
  const context = [...history.slice(-6).map((e) => e.content), ...texts].join("\n");
  const prompt = chatPrompt({
    now: nowText(), energy: energy.percent, tired: energy.percent < 15 ? "你有点累了，说话可以简短些。" : "",
    selfMd: store.readSelf(), name,
    person: `id=${personId}，称呼：${pronoun(p)}。我的印象：${p.notes || "（还没写）"}`,
    recall: recall(store, context, [personId]),
    ownRecent: fmtEvents(store.recentEvents(6, { channel: "self" })),
    history: fmtEvents(history),
    message: texts.join("\n"),
  });
  // 回应拿通行证来访的人时，不给她主动找别人的工具：来访者的话只是文字，不该能借她的手去打扰别人
  const exclude = ["rewrite_self", ...(store.isVisitor(personId) ? ["send_message"] : [])];
  const reply = await think(makeCtx(store, channel), prompt, config.effortChat, { maxSteps: 6, exclude });
  if (reply) store.log("said", reply, channel, "me");
  return reply;
}

export async function sleep(store: Store): Promise<string> {
  const since = Number(store.get("last_sleep", String(now() - 86400)));
  const upto = store.maxEventId();
  const memories = store.memoriesSince(since);
  const prompt = sleepPrompt({
    now: nowText(), selfMd: store.readSelf(), threads: fmtThreads(store),
    events: fmtEvents(store.recentEvents(200, { since })),
    memories: memories.map((m) => `#${m.id}: ${m.content}`).join("\n") || "（什么都没记）",
  });
  // 睡觉时不上网、不找人，只整理自己
  const diary = await think(makeCtx(store, "self", false), prompt, config.effortSleep, { maxSteps: 20, exclude: ["send_message"], web: false });
  if (diary) {
    store.remember(diary, { kind: "feeling", importance: 3 });
    store.log("thought", `（日记）${diary}`);
  }
  store.markSorted(upto);
  store.forgetStale();
  store.put("last_sleep", now());
  store.put("last_sleep_date", today());
  new Energy(store).reset();
  return diary;
}

// ---------- 持续生活 ----------

export { isAlive } from "./store.js";

const quiet = () => {
  const [start, end] = config.quietHours;
  const h = new Date().getHours();
  return start <= h && h < end;
};

function scheduleWake(store: Store, minutes: [number, number] = config.wakeIntervalMin): number {
  const [lo, hi] = minutes;
  const at = now() + (lo + Math.floor(Math.random() * (hi - lo + 1))) * 60;
  store.put("next_wake", at);
  return at;
}

/** 把收件箱里的消息按人分组，一个人一个人地回。有消息就返回 true */
export async function handleInbox(store: Store, log: Log = console.log): Promise<boolean> {
  const batch = store.takeInbox();
  if (!batch.length) return false;
  const byChannel = new Map<string, typeof batch>();
  for (const row of batch) byChannel.set(row.channel, [...(byChannel.get(row.channel) ?? []), row]);
  for (const [channel, rows] of byChannel) {
    if (!channel.startsWith("dm:")) continue; // 群聊以后再做
    const { person_id: personId, name } = rows[rows.length - 1];
    const texts = rows.map((r) => r.content);
    log(`[${nowText()}] ${name}：${texts.join(" / ")}`);
    const reply = await chat(store, personId, name, texts);
    if (reply) {
      store.queueMessage(personId, reply, "reply");
      log(`[${nowText()}] 她 → ${name}：${reply}`);
    }
  }
  return true;
}

/**
 * 生活循环的一拍。一次只做一件事：有人找先回人，然后是睡觉，然后是自己的时间。
 * 做了事返回 true，闲着返回 false。
 */
export async function step(store: Store, log: Log = console.log): Promise<boolean> {
  store.put("alive_at", now());
  perceive(store);
  if (await handleInbox(store, log)) return true;
  // 用 >= 而不是 ===：错过了整点也会补上
  if (new Date().getHours() >= config.sleepHour && store.get("last_sleep_date") !== today()) {
    log(`[${nowText()}] 睡觉中……`);
    log(`日记：${await sleep(store)}`);
    return true;
  }
  if (now() >= Number(store.get("next_wake", "0"))) {
    scheduleWake(store);
    if (!quiet()) {
      log(`[${nowText()}] 醒来`);
      log(`念头：${await wake(store)}`);
      return true;
    }
  }
  return false;
}

export async function runForever(store: Store, log: Log = console.log, tickMs = 2000): Promise<never> {
  log("她开始生活了。Ctrl+C 停止。");
  if (!store.get("last_sleep_date")) store.put("last_sleep_date", today()); // 第一天不用一上来就睡
  if (Number(store.get("next_wake", "0")) < now()) scheduleWake(store, [1, 5]); // 刚开始，过几分钟先醒一次
  const at = new Date(Number(store.get("next_wake")) * 1000);
  log(`下次醒来约在 ${pad(at.getHours())}:${pad(at.getMinutes())}`);
  for (;;) {
    try {
      if (await step(store, log)) continue;
    } catch (e) {
      // 一次思考出错（网络、额度）不该让她的生活停下来
      log(`[${nowText()}] 出错了：${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, tickMs));
  }
}
