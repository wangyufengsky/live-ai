/**
 * 宿舍的生活循环（DESIGN.md 11.2–11.7）。
 *
 * - 投递：按顺序读出世界事件，交给当时在场、醒着的人（写进她们各自的“最近发生的事”）
 * - 主持人：有人在一个地方说话，攒一会儿，排好顺序，一个一个请在场的居民说；被请到的可以不说
 * - 敲门：门的主人自己决定开不开
 * - 每位居民自己的生活：真的睡觉、醒来、回私信、自己的时间
 *
 * 每位居民一把锁：她一次只想一件事，不管是被主持人请到、有人敲门、还是自己醒来。
 */

import { think } from "./brains/index.js";
import { config } from "./config.js";
import { Energy, today } from "./energy.js";
import { chat, nowText, sleep, wake, whereFor } from "./life.js";
import { perceive } from "./perception.js";
import { isPass, knockPrompt, scenePrompt } from "./prompts.js";
import { recall } from "./recall.js";
import { fmtTs, now, Store } from "./store.js";
import { makeCtx, type CtxEnv } from "./tools.js";
import { audienceOf, World, type WorldEvent } from "./world.js";
import "./worldTools.js";

type Log = (line: string) => void;

/** 一次只做一件事 */
export class Lock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

export interface Resident { id: string; store: Store; lock: Lock; env: CtxEnv }

interface Scene {
  dirtyAt: number;            // 最近一句话的时间（毫秒），0 = 没有在等人接话
  lastSpeaker: string;
  lastText: string;
  queue: string[] | null;     // 这一批要请的人，null = 下次重新排
  aiStreak: number;           // 上一次有人类说话之后，AI 连着说了几句
  cooldownUntil: number;      // 毫秒
  busy: boolean;
  lastSpoke: Map<string, number>;
}

const inWindow = (h: number, start: number, end: number) => (start <= end ? start <= h && h < end : h >= start || h < end);

export class Dorm {
  readonly residents = new Map<string, Resident>();
  readonly scenes = new Map<string, Scene>();
  private handledKnocks = new Set<number>();
  /** 统计：主持人请了几次、说了几次、不说几次（11.5：跑一段时间看比例） */
  readonly stats = { invited: 0, said: 0, passed: 0 };

  constructor(readonly world: World = new World(), private log: Log = console.log) {
    for (const r of world.residents()) this.attach(r.id);
  }

  /** 把世界名册里的居民接上她自己的存储 */
  attach(id: string): Resident {
    const row = this.world.resident(id)!;
    const resident: Resident = { id, store: new Store(row.dir), lock: new Lock(), env: { brain: row.brain, world: this.world, residentId: id } };
    this.residents.set(id, resident);
    return resident;
  }

  // ---------- 投递 ----------

  /** 把还没投递的世界事件交给当时的听众；有人说话就交给主持人 */
  deliver() {
    const upto = Number(this.world.get("delivered_upto") ?? 0);
    const events = this.world.eventsSince(upto);
    for (const ev of events) {
      const actorName = this.world.nameOf(ev.actor);
      for (const who of audienceOf(ev)) {
        const r = this.residents.get(who);
        if (!r) continue; // 人类听众从世界里自己看
        if (ev.kind === "say") r.store.log("heard", ev.content, `place:${ev.place}`, actorName);
        else r.store.log("system", ev.content, `place:${ev.place}`);
      }
      if (ev.kind === "say") this.noteSpeech(ev);
    }
    if (events.length) this.world.put("delivered_upto", events[events.length - 1].id);
  }

  // ---------- 主持人（11.5） ----------

  private scene(place: string): Scene {
    let s = this.scenes.get(place);
    if (!s) {
      s = { dirtyAt: 0, lastSpeaker: "", lastText: "", queue: null, aiStreak: 0, cooldownUntil: 0, busy: false, lastSpoke: new Map() };
      this.scenes.set(place, s);
    }
    return s;
  }

  private noteSpeech(ev: WorldEvent) {
    const s = this.scene(ev.place);
    const human = ev.actor.startsWith("human:");
    s.aiStreak = human ? 0 : s.aiStreak + 1;
    if (human) s.cooldownUntil = 0;
    s.lastSpeaker = ev.actor;
    s.lastText = ev.content;
    s.lastSpoke.set(ev.actor, ev.ts * 1000);
    s.queue = null;
    if (!human && s.aiStreak >= config.sceneAiLimit) {
      s.cooldownUntil = Date.now() + config.sceneCooldownMin * 60_000;
      s.dirtyAt = 0;
      this.log(`[${nowText()}] ${this.world.place(ev.place)?.name}：AI 之间已经说了 ${s.aiStreak} 句，冷却 ${config.sceneCooldownMin} 分钟`);
      return;
    }
    s.dirtyAt = Date.now();
  }

  /** 排顺序：被点名的 → 想找说话人聊的 → 最近没说过话的 → 随机 */
  private order(place: string, s: Scene): string[] {
    const candidates = this.world.whoIsAt(place, true).map((p) => p.entity)
      .filter((e) => this.residents.has(e) && e !== s.lastSpeaker);
    const mentioned = (id: string) => {
      const r = this.world.resident(id)!;
      return [r.id, r.name, r.placeholder].some((n) => n && s.lastText.includes(n));
    };
    const wantsToTalk = (id: string) => this.world.intents(id).some((i) => i.target === s.lastSpeaker);
    const rank = (id: string) => (mentioned(id) ? 0 : wantsToTalk(id) ? 1 : 2);
    return candidates
      .map((id) => ({ id, rank: rank(id), last: s.lastSpoke.get(id) ?? 0, tie: Math.random() }))
      .sort((a, b) => a.rank - b.rank || a.last - b.last || a.tie - b.tie)
      .map((x) => x.id);
  }

  /** 每个地方最多请一个人；返回这一拍有没有请人 */
  async moderate(): Promise<boolean> {
    let acted = false;
    for (const [place, s] of this.scenes) {
      if (!s.dirtyAt || s.busy) continue;
      if (Date.now() < s.cooldownUntil) continue;
      if (Date.now() - s.dirtyAt < config.sceneBatchMs) continue;
      s.queue ??= this.order(place, s);
      const next = s.queue.shift();
      if (!next) {
        s.dirtyAt = 0; // 大家都说过或都不说，这一段就散了
        continue;
      }
      s.busy = true;
      try {
        await this.turn(next, place);
        acted = true;
      } finally {
        s.busy = false;
      }
    }
    return acted;
  }

  /** 轮到她说话：说一句，或者不说 */
  async turn(id: string, place: string): Promise<"said" | "passed" | "skipped"> {
    const r = this.residents.get(id)!;
    return r.lock.run(async () => {
      if (!this.world.isAwake(id) || this.world.location(id) !== place) return "skipped";
      this.stats.invited++;
      const transcript = this.world.heardBy(id, { place, limit: 20 }).filter((e) => e.kind === "say")
        .map((e) => `${fmtTs(e.ts)} ${e.actor === id ? "我" : this.world.nameOf(e.actor)}：${e.content}`);
      const s = this.scene(place);
      const intent = this.world.intents(id).find((i) => i.target === s.lastSpeaker);
      const prompt = scenePrompt({
        now: nowText(), energy: new Energy(r.store).percent, selfMd: r.store.readSelf(), where: whereFor(r.env),
        transcript: transcript.join("\n") || "（还没人说话）",
        recall: recall(r.store, transcript.slice(-6).join("\n"), [s.lastSpeaker.replace(/^human:/, "")]),
        reason: intent ? `你之前想找${this.world.nameOf(intent.target)}聊“${intent.topic}”（#${intent.id}）。` : "",
      });
      const reply = await think(makeCtx(r.store, `place:${place}`, true, r.env), prompt, config.effortChat,
        { maxSteps: 6, exclude: ["say", "rewrite_self", "send_message"] });
      if (this.world.location(id) !== place) return "skipped"; // 她走开了
      if (isPass(reply)) {
        this.stats.passed++;
        r.store.log("did", `在${this.world.place(place)?.name}没有接话`, `place:${place}`, "me");
        return "passed";
      }
      this.world.say(id, reply);
      r.store.log("said", reply, `place:${place}`, "me");
      this.stats.said++;
      this.log(`[${nowText()}] ${this.world.place(place)?.name}｜${this.world.nameOf(id)}：${reply}`);
      return "said";
    });
  }

  // ---------- 敲门 ----------

  private async answerKnocks(r: Resident): Promise<boolean> {
    const knocks = this.world.pendingKnocks(r.id).filter((k) => !this.handledKnocks.has(k.id));
    if (!knocks.length) return false;
    for (const k of knocks) {
      this.handledKnocks.add(k.id);
      await r.lock.run(async () => {
        const visitor = this.world.nameOf(k.visitor);
        const prompt = knockPrompt({
          now: nowText(), where: whereFor(r.env), visitor, selfMd: r.store.readSelf(),
          recall: recall(r.store, visitor, [k.visitor.replace(/^human:/, "")]),
        });
        const reply = await think(makeCtx(r.store, `place:${k.place}`, true, r.env), prompt, config.effortChat,
          { maxSteps: 4, exclude: ["say", "go_to", "rewrite_self", "send_message"] });
        const stillPending = this.world.pendingKnocks(r.id).some((p) => p.id === k.id);
        if (stillPending) {
          // 她自己可能也写了“（隔着门）”，框架已经会说“隔着门说：”，去掉重复的
          const note = reply.replace(/^\s*[（(]隔着门[）)]\s*/, "").trim();
          this.world.decline(r.id, k.visitor, isPass(note) ? undefined : note);
          this.log(`[${nowText()}] ${this.world.nameOf(r.id)}没有给${visitor}开门${isPass(note) ? "" : `，隔着门说：${note}`}`);
        } else {
          this.log(`[${nowText()}] ${this.world.nameOf(r.id)}给${visitor}开了门`);
          if (!isPass(reply)) {
            this.world.say(r.id, reply);
            r.store.log("said", reply, `place:${k.place}`, "me");
          }
        }
      });
    }
    return true;
  }

  // ---------- 每位居民自己的生活 ----------

  private async handleInbox(r: Resident): Promise<boolean> {
    const batch = r.store.takeInbox();
    if (!batch.length) return false;
    const byPerson = new Map<string, typeof batch>();
    for (const row of batch) byPerson.set(row.person_id, [...(byPerson.get(row.person_id) ?? []), row]);
    for (const [personId, rows] of byPerson) {
      const name = rows[rows.length - 1].name;
      const reply = await r.lock.run(() => chat(r.store, personId, name, rows.map((x) => x.content), r.env));
      if (reply) r.store.queueMessage(personId, reply, "reply");
    }
    return true;
  }

  /** 一位居民的一拍：睡觉 / 醒来 → 有人敲门 → 有人私下找 → 自己的时间 */
  async residentStep(id: string): Promise<boolean> {
    const r = this.residents.get(id)!;
    const row = this.world.resident(id)!;
    r.store.put("alive_at", now());
    perceive(r.store);
    const h = new Date().getHours();
    const sleepTime = inWindow(h, row.sleep_hour, row.wake_hour);

    if (sleepTime && !row.asleep && r.store.get("last_sleep_date") !== today()) {
      this.log(`[${nowText()}] ${this.world.nameOf(id)}睡觉了`);
      const diary = await r.lock.run(() => sleep(r.store, r.env));
      this.world.setAsleep(id, true);
      if (diary) this.log(`日记（${this.world.nameOf(id)}）：${diary}`);
      return true;
    }
    if (!sleepTime && row.asleep) {
      this.world.setAsleep(id, false);
      r.store.log("system", "醒了。睡着的时候别人在别处说的话，没有听到；私下找我的消息和敲门，都还在。");
      r.store.put("next_wake", 0);
      this.log(`[${nowText()}] ${this.world.nameOf(id)}醒了`);
      return true;
    }
    if (row.asleep) return false; // 睡着时：不进场景、不回消息，攒着

    if (await this.answerKnocks(r)) return true;
    if (await this.handleInbox(r)) return true;

    if (now() >= Number(r.store.get("next_wake", "0"))) {
      const [lo, hi] = config.wakeIntervalMin;
      r.store.put("next_wake", now() + (lo + Math.floor(Math.random() * (hi - lo + 1))) * 60);
      const [qs, qe] = config.quietHours;
      if (!inWindow(h, qs, qe)) {
        const thought = await r.lock.run(() => wake(r.store, r.env));
        this.log(`[${nowText()}] ${this.world.nameOf(id)}醒来想：${thought}`);
        return true;
      }
    }
    return false;
  }

  /** 人一段时间没动静，就算离开了 */
  expireHumans() {
    const cutoff = now() - config.humanIdleMin * 60;
    for (const pl of this.world.places()) {
      for (const p of this.world.whoIsAt(pl.id)) if (p.kind === "human" && p.last_active < cutoff) this.world.leaveHuman(p.entity);
    }
  }

  /** 整个宿舍的一拍（测试用，按顺序跑完） */
  async tick(): Promise<void> {
    this.deliver();
    this.expireHumans();
    await this.moderate();
    for (const id of this.residents.keys()) await this.residentStep(id);
    this.deliver();
  }

  /** 持续生活：投递和主持人一条循环，每位居民各自一条循环 */
  async runForever(tickMs = 1000): Promise<never> {
    const loop = async (name: string, fn: () => Promise<boolean>) => {
      for (;;) {
        let busy = false;
        try {
          busy = await fn();
        } catch (e) {
          this.log(`[${nowText()}] ${name} 出错了：${e instanceof Error ? e.message : String(e)}`);
        }
        if (!busy) await new Promise((r) => setTimeout(r, tickMs));
      }
    };
    for (const id of this.residents.keys()) {
      const r = this.residents.get(id)!;
      if (Number(r.store.get("next_wake", "0")) < now()) r.store.put("next_wake", now() + (1 + Math.floor(Math.random() * 5)) * 60);
      void loop(`居民 ${id}`, () => this.residentStep(id));
    }
    return loop("主持人", async () => {
      this.deliver();
      this.expireHumans();
      return this.moderate();
    }) as Promise<never>;
  }
}
