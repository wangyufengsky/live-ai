/**
 * 世界：宿舍里的事实（DESIGN.md 11.2–11.4）。
 *
 * 有哪些地方、谁在哪、门开着还是关着、谁说了什么、当时谁听到了。世界说她在客厅，她就在客厅。
 * 她说“我去客厅了”不算数，调用 goTo 才算（11.3 第 3 条）。
 *
 * 世界只记录事实，不投递。每件事写成一条世界事件（带当时在场、醒着的听众），
 * 由宿舍的生活循环（dorm.ts）按顺序读出来、投递给听众。这样不管是居民通过 MCP、
 * 还是人在另一个进程里用命令行，走的都是同一条路。
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { now } from "./store.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS places (
    id TEXT PRIMARY KEY,          -- living / room:<居民 id>
    kind TEXT NOT NULL,           -- room / common
    name TEXT NOT NULL,
    owner TEXT,                   -- 房间的主人（居民 id）；公共区域为空
    door TEXT NOT NULL DEFAULT 'closed'
);
CREATE TABLE IF NOT EXISTS residents (
    id TEXT PRIMARY KEY,          -- 稳定的 id：r1、r2……
    placeholder TEXT NOT NULL,    -- 还没取名字时别人怎么称呼：她 / 新室友
    name TEXT,                    -- 她自己取的名字
    brain TEXT NOT NULL,
    dir TEXT NOT NULL,            -- 她自己的数据目录
    sleep_hour INTEGER NOT NULL DEFAULT 2,
    wake_hour INTEGER NOT NULL DEFAULT 8,
    asleep INTEGER NOT NULL DEFAULT 0,
    fell_asleep REAL,
    joined REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS presence (
    entity TEXT PRIMARY KEY,      -- 居民 id，或 human:<id>
    kind TEXT NOT NULL,           -- resident / human
    name TEXT NOT NULL,
    place TEXT NOT NULL,
    since REAL NOT NULL,
    last_active REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS world_events (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    place TEXT NOT NULL,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,           -- say / arrive / leave / knock / door / name / let_in / decline
    content TEXT NOT NULL,
    target TEXT,                  -- 敲门、开门、婉拒时针对的人
    audience TEXT NOT NULL        -- 当时在场、醒着、听得到的人（JSON 列表，不含 actor）
);
CREATE TABLE IF NOT EXISTS intents (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    resident TEXT NOT NULL,
    target TEXT NOT NULL,
    topic TEXT NOT NULL,
    expires REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' -- open / done / dropped / expired
);
CREATE TABLE IF NOT EXISTS knocks (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    place TEXT NOT NULL,
    owner TEXT NOT NULL,
    visitor TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- pending / let_in / declined / expired
    note TEXT
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export const LIVING = "living";
export const roomOf = (residentId: string) => `room:${residentId}`;
export const HUMAN = (id: string) => `human:${id}`;

export interface PlaceRow { id: string; kind: "room" | "common"; name: string; owner: string | null; door: "open" | "closed" }
export interface ResidentRow {
  id: string; placeholder: string; name: string | null; brain: string; dir: string;
  sleep_hour: number; wake_hour: number; asleep: number; fell_asleep: number | null; joined: number;
}
export interface PresenceRow { entity: string; kind: "resident" | "human"; name: string; place: string; since: number; last_active: number }
export interface WorldEvent {
  id: number; ts: number; place: string; actor: string; kind: string; content: string; target: string | null; audience: string;
}
export interface IntentRow { id: number; ts: number; resident: string; target: string; topic: string; expires: number; status: string }
export interface KnockRow { id: number; ts: number; place: string; owner: string; visitor: string; status: string; note: string | null }

export const audienceOf = (ev: WorldEvent): string[] => JSON.parse(ev.audience) as string[];

export class World {
  readonly db: Database.Database;
  readonly dir: string;

  constructor(dir: string = config.dormDir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(path.join(dir, "world.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.db.prepare("INSERT OR IGNORE INTO places (id, kind, name, owner, door) VALUES (?, 'common', '客厅', NULL, 'open')").run(LIVING);
  }

  close() {
    this.db.close();
  }

  get(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  put(key: string, value: string | number) {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
  }

  // ---------- 居民 ----------

  /** 搬进来一位居民：给 ta 一间房（门默认关着），人先待在自己房间里 */
  addResident(id: string, opts: { brain: string; placeholder: string; dir?: string; sleepHour?: number; wakeHour?: number }) {
    const dir = opts.dir ?? path.join(this.dir, "residents", id);
    this.db.transaction(() => {
      this.db.prepare(
        "INSERT INTO residents (id, placeholder, brain, dir, sleep_hour, wake_hour, joined) VALUES (?,?,?,?,?,?,?)",
      ).run(id, opts.placeholder, opts.brain, dir, opts.sleepHour ?? 2, opts.wakeHour ?? 8, now());
      this.db.prepare("INSERT INTO places (id, kind, name, owner, door) VALUES (?, 'room', ?, ?, 'closed')")
        .run(roomOf(id), `${opts.placeholder}的房间`, id);
      this.db.prepare("INSERT INTO presence (entity, kind, name, place, since, last_active) VALUES (?, 'resident', ?, ?, ?, ?)")
        .run(id, opts.placeholder, roomOf(id), now(), now());
    })();
    return this.resident(id)!;
  }

  resident(id: string): ResidentRow | undefined {
    return this.db.prepare("SELECT * FROM residents WHERE id = ?").get(id) as ResidentRow | undefined;
  }

  residents(): ResidentRow[] {
    return this.db.prepare("SELECT * FROM residents ORDER BY joined").all() as ResidentRow[];
  }

  isResident(entity: string) {
    return Boolean(this.resident(entity));
  }

  /** 怎么称呼：她自己取的名字，没取就用占位的称呼；人用 ta 进门时的名字 */
  nameOf(entity: string): string {
    const r = this.resident(entity);
    if (r) return r.name ?? r.placeholder;
    return this.presence(entity)?.name ?? entity;
  }

  /** 她给自己取名字（10.8：名字让她自己取） */
  setName(id: string, name: string) {
    const old = this.nameOf(id);
    this.db.prepare("UPDATE residents SET name = ? WHERE id = ?").run(name, id);
    this.db.prepare("UPDATE presence SET name = ? WHERE entity = ?").run(name, id);
    this.db.prepare("UPDATE places SET name = ? WHERE id = ?").run(`${name}的房间`, roomOf(id));
    this.emit(id, "name", `${old}给自己取了名字：${name}`);
  }

  setAsleep(id: string, asleep: boolean) {
    this.db.prepare("UPDATE residents SET asleep = ?, fell_asleep = ? WHERE id = ?").run(asleep ? 1 : 0, asleep ? now() : this.resident(id)?.fell_asleep ?? null, id);
  }

  isAwake(entity: string): boolean {
    const r = this.resident(entity);
    return r ? !r.asleep : true; // 人总是醒着的（在场就算）
  }

  // ---------- 地点和在哪 ----------

  place(id: string): PlaceRow | undefined {
    return this.db.prepare("SELECT * FROM places WHERE id = ?").get(id) as PlaceRow | undefined;
  }

  places(): PlaceRow[] {
    return this.db.prepare("SELECT * FROM places ORDER BY kind DESC, id").all() as PlaceRow[];
  }

  presence(entity: string): PresenceRow | undefined {
    return this.db.prepare("SELECT * FROM presence WHERE entity = ?").get(entity) as PresenceRow | undefined;
  }

  location(entity: string): string | undefined {
    return this.presence(entity)?.place;
  }

  /** 此刻在这个地方的人；awakeOnly 时只算醒着的 */
  whoIsAt(place: string, awakeOnly = false): PresenceRow[] {
    const rows = this.db.prepare("SELECT * FROM presence WHERE place = ? ORDER BY since").all(place) as PresenceRow[];
    return awakeOnly ? rows.filter((r) => this.isAwake(r.entity)) : rows;
  }

  /** 把“客厅”“我的房间”“r2 的房间”“room:r2”这类说法认成地点 id */
  resolvePlace(entity: string, text: string): string | undefined {
    const t = text.trim();
    if (this.place(t)) return t;
    if (/客厅|公共/.test(t)) return LIVING;
    if (/^(我的?房间|自己的?房间|回房)/.test(t) && this.isResident(entity)) return roomOf(entity);
    for (const r of this.residents()) {
      if ([r.id, r.name, r.placeholder].some((n) => n && t.includes(n))) return roomOf(r.id);
    }
    return undefined;
  }

  touch(entity: string) {
    this.db.prepare("UPDATE presence SET last_active = ? WHERE entity = ?").run(now(), entity);
  }

  // ---------- 事件 ----------

  /** 记一件事：听众 = 此刻在这个地方、醒着的人（不含说话的人自己） */
  private emit(actor: string, kind: string, content: string, opts: { place?: string; target?: string; extraAudience?: string[] } = {}): WorldEvent {
    const place = opts.place ?? this.location(actor) ?? LIVING;
    const audience = new Set(this.whoIsAt(place, true).map((p) => p.entity).filter((e) => e !== actor));
    for (const e of opts.extraAudience ?? []) audience.add(e);
    const info = this.db.prepare(
      "INSERT INTO world_events (ts, place, actor, kind, content, target, audience) VALUES (?,?,?,?,?,?,?)",
    ).run(now(), place, actor, kind, content, opts.target ?? null, JSON.stringify([...audience]));
    return this.db.prepare("SELECT * FROM world_events WHERE id = ?").get(Number(info.lastInsertRowid)) as WorldEvent;
  }

  eventsSince(id: number): WorldEvent[] {
    return this.db.prepare("SELECT * FROM world_events WHERE id > ? ORDER BY id").all(id) as WorldEvent[];
  }

  /** 这个人在某个地方听到过、或者自己说过的事（不在场的不会出现） */
  heardBy(entity: string, opts: { place?: string; limit?: number; sinceId?: number } = {}): WorldEvent[] {
    const rows = this.db.prepare(
      `SELECT * FROM world_events WHERE id > ? ${opts.place ? "AND place = ?" : ""} ORDER BY id DESC LIMIT 400`,
    ).all(...[opts.sinceId ?? 0, ...(opts.place ? [opts.place] : [])]) as WorldEvent[];
    return rows.filter((e) => e.actor === entity || audienceOf(e).includes(entity)).slice(0, opts.limit ?? 30).reverse();
  }

  maxEventId(): number {
    return (this.db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM world_events").get() as { n: number }).n;
  }

  // ---------- 动作 ----------

  /** 人走进宿舍（默认在客厅） */
  enterHuman(id: string, name: string, place = LIVING) {
    const entity = HUMAN(id);
    this.db.prepare(
      "INSERT INTO presence (entity, kind, name, place, since, last_active) VALUES (?, 'human', ?, ?, ?, ?) " +
      "ON CONFLICT(entity) DO UPDATE SET name = excluded.name, last_active = excluded.last_active",
    ).run(entity, name, place, now(), now());
    const p = this.presence(entity)!;
    if (p.since >= now() - 1) this.emit(entity, "arrive", `${name}走进了${this.place(p.place)!.name}`);
    return entity;
  }

  leaveHuman(entity: string) {
    const p = this.presence(entity);
    if (!p) return;
    this.emit(entity, "leave", `${p.name}离开了宿舍`);
    this.db.prepare("DELETE FROM presence WHERE entity = ?").run(entity);
  }

  /**
   * 移动。目标是别人的房间、门又关着 → 变成敲门，由房间的主人决定（11.3 第 4 条，人也一样）。
   */
  goTo(entity: string, target: string): { moved: boolean; knocked?: boolean; message: string } {
    const here = this.location(entity);
    const place = this.place(target);
    if (!place) return { moved: false, message: "没有这个地方。" };
    if (here === target) return { moved: false, message: `已经在${place.name}了。` };
    if (place.kind === "room" && place.owner !== entity && place.door === "closed") {
      const pending = this.db.prepare("SELECT id FROM knocks WHERE place = ? AND visitor = ? AND status = 'pending'").get(target, entity);
      if (!pending) {
        this.db.prepare("INSERT INTO knocks (ts, place, owner, visitor) VALUES (?,?,?,?)").run(now(), target, place.owner, entity);
        // 敲门声：门外的人看得到，门里醒着的主人听得到
        this.emit(entity, "knock", `${this.nameOf(entity)}敲了${place.name}的门`, { target: place.owner!, extraAudience: this.isAwake(place.owner!) ? [place.owner!] : [] });
      }
      return { moved: false, knocked: true, message: `${place.name}的门关着，你敲了门。等${this.nameOf(place.owner!)}决定开不开。` };
    }
    this.move(entity, target);
    return { moved: true, message: `你到了${place.name}。` };
  }

  private move(entity: string, target: string) {
    const from = this.location(entity);
    const name = this.nameOf(entity);
    if (from) this.emit(entity, "leave", `${name}离开了${this.place(from)!.name}`, { place: from });
    this.db.prepare("UPDATE presence SET place = ?, since = ?, last_active = ? WHERE entity = ?").run(target, now(), now(), entity);
    this.emit(entity, "arrive", `${name}来到了${this.place(target)!.name}`, { place: target });
  }

  /** 只能设自己房间的门 */
  setDoor(entity: string, door: "open" | "closed"): string {
    const room = this.place(roomOf(entity));
    if (!room) return "你没有自己的房间。";
    this.db.prepare("UPDATE places SET door = ? WHERE id = ?").run(door, room.id);
    this.emit(entity, "door", `${this.nameOf(entity)}把门${door === "open" ? "打开" : "关上"}了`, { place: room.id });
    return door === "open" ? "门开着了，别人可以直接进来。" : "门关上了，别人要进来得先敲门。";
  }

  pendingKnocks(owner: string): KnockRow[] {
    return this.db.prepare("SELECT * FROM knocks WHERE owner = ? AND status = 'pending' ORDER BY ts").all(owner) as KnockRow[];
  }

  /** 主人开门，让敲门的人进来 */
  letIn(owner: string, visitor: string): string {
    const knock = this.db.prepare("SELECT * FROM knocks WHERE owner = ? AND visitor = ? AND status = 'pending'").get(owner, visitor) as KnockRow | undefined;
    if (!knock) return `${this.nameOf(visitor)}没有在敲你的门。`;
    this.db.prepare("UPDATE knocks SET status = 'let_in' WHERE id = ?").run(knock.id);
    this.emit(owner, "let_in", `${this.nameOf(owner)}开了门`, { place: knock.place, target: visitor, extraAudience: [visitor] });
    this.move(visitor, knock.place);
    return `你开了门，${this.nameOf(visitor)}进来了。`;
  }

  /** 主人不开门，可以隔着门说一句 */
  decline(owner: string, visitor: string, note?: string) {
    const knock = this.db.prepare("SELECT * FROM knocks WHERE owner = ? AND visitor = ? AND status = 'pending'").get(owner, visitor) as KnockRow | undefined;
    if (!knock) return;
    this.db.prepare("UPDATE knocks SET status = 'declined', note = ? WHERE id = ?").run(note ?? null, knock.id);
    this.emit(owner, "decline", note ? `${this.nameOf(owner)}隔着门说：${note}` : `${this.nameOf(owner)}没有开门`,
      { place: this.location(visitor), target: visitor, extraAudience: [visitor] });
  }

  /** 在自己所在的地方说话：此刻在场、醒着的人听得到 */
  say(entity: string, text: string): WorldEvent {
    this.touch(entity);
    return this.emit(entity, "say", text);
  }

  // ---------- 想找谁聊聊（11.7） ----------

  addIntent(resident: string, target: string, topic: string, days = 3): number {
    return Number(this.db.prepare("INSERT INTO intents (ts, resident, target, topic, expires) VALUES (?,?,?,?,?)")
      .run(now(), resident, target, topic, now() + days * 86400).lastInsertRowid);
  }

  intents(resident: string): IntentRow[] {
    this.db.prepare("UPDATE intents SET status = 'expired' WHERE status = 'open' AND expires < ?").run(now());
    return this.db.prepare("SELECT * FROM intents WHERE resident = ? AND status = 'open' ORDER BY ts").all(resident) as IntentRow[];
  }

  /** 谁想找这个人聊（主持人排顺序时用） */
  intentsToward(target: string): IntentRow[] {
    return this.db.prepare("SELECT * FROM intents WHERE target = ? AND status = 'open' AND expires >= ?").all(target, now()) as IntentRow[];
  }

  closeIntent(resident: string, id: number, status: "done" | "dropped"): boolean {
    return this.db.prepare("UPDATE intents SET status = ? WHERE id = ? AND resident = ? AND status = 'open'").run(status, id, resident).changes > 0;
  }
}
