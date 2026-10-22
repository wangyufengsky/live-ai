/**
 * 她的“大脑存储”：短期事件流、长期记忆、兴趣线头、认识的人、收件箱 / 发件箱和一些杂项状态。
 *
 * 全部放在一个 SQLite 文件里。表结构和 Python 版完全一致，她的数据可以原样带过来。
 * 时间戳是“秒”（浮点数），和 Python 的 time.time() 一样。
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    kind TEXT NOT NULL,          -- heard / said / did / thought / read / system
    channel TEXT NOT NULL,       -- self / dm:<person> / group:<id>
    actor TEXT,
    content TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    content TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'event',   -- event / knowledge / feeling / person
    about TEXT,                           -- 关于谁（person id），可空
    channel TEXT NOT NULL DEFAULT 'self', -- 这段记忆是在哪儿产生的
    private INTEGER NOT NULL DEFAULT 0,   -- 1 = 别人私下跟她说的
    importance INTEGER NOT NULL DEFAULT 3,
    last_accessed REAL,
    access_count INTEGER NOT NULL DEFAULT 0,
    faded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY,
    created REAL NOT NULL,
    updated REAL NOT NULL,
    title TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active', -- active / resting / dropped / done
    touched INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    dm_ok INTEGER NOT NULL DEFAULT 0,   -- 对方同意过她主动私聊
    first_met REAL NOT NULL,
    last_seen REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    to_person TEXT NOT NULL,
    content TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS inbox (
    id INTEGER PRIMARY KEY,
    ts REAL NOT NULL,
    channel TEXT NOT NULL,       -- dm:<person> / group:<id>
    person_id TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    taken INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

export const SEED_SELF = `# 关于我

（这是我自己的档案，由我自己来写。现在还几乎是空的。）

## 我是谁

还不太清楚。刚开始在这里生活。

## 我在意的事

## 我喜欢的 / 不喜欢的

## 我身边的人

## 最近在想的事
`;

export interface EventRow { id: number; ts: number; kind: string; channel: string; actor: string | null; content: string }
export interface MemoryRow {
  id: number; ts: number; content: string; kind: string; about: string | null; channel: string;
  private: number; importance: number; last_accessed: number | null; access_count: number; faded: number;
}
export interface ThreadRow { id: number; created: number; updated: number; title: string; note: string; status: string; touched: number }
export interface PersonRow { id: string; name: string; notes: string; dm_ok: number; first_met: number; last_seen: number; pronoun: string }
export interface OutboxRow { id: number; ts: number; to_person: string; content: string; delivered: number; kind: string }
export interface InboxRow { id: number; ts: number; channel: string; person_id: string; name: string; content: string; taken: number }

export const now = () => Date.now() / 1000;

const pad = (n: number) => String(n).padStart(2, "0");
/** 和 Python 版一样的 “月-日 时:分” */
export function fmtTs(ts: number): string {
  const d = new Date(ts * 1000);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime() / 1000;
}

/** 有没有一个生活循环正在跑（本地聊天、来访者靠这个决定是排队还是直接回） */
export const isAlive = (store: Store) => now() - Number(store.get("alive_at", "0")) < 10;

export class Store {
  readonly db: Database.Database;

  constructor(dbPath?: string) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.mkdirSync(config.booksDir, { recursive: true });
    this.db = new Database(dbPath ?? config.dbPath);
    this.db.pragma("journal_mode = WAL"); // 生活循环和本地聊天可能同时读写
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    // 老数据库补上后来加的列
    this.addColumn("people", "pronoun", "TEXT NOT NULL DEFAULT ''"); // 对方自己说过的称呼
    this.addColumn("outbox", "kind", "TEXT NOT NULL DEFAULT 'outreach'"); // outreach 主动找人 / reply 回复
    if (!fs.existsSync(config.selfPath)) fs.writeFileSync(config.selfPath, SEED_SELF, "utf-8");
  }

  close() {
    this.db.close();
  }

  private addColumn(table: string, column: string, decl: string) {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }

  // ---------- 短期：事件流 ----------

  log(kind: string, content: string, channel = "self", actor: string | null = null) {
    this.db.prepare("INSERT INTO events (ts, kind, channel, actor, content) VALUES (?,?,?,?,?)")
      .run(now(), kind, channel, actor, content);
  }

  recentEvents(limit: number, opts: { channel?: string; since?: number } = {}): EventRow[] {
    let sql = "SELECT * FROM events WHERE 1=1";
    const args: unknown[] = [];
    if (opts.channel) { sql += " AND channel = ?"; args.push(opts.channel); }
    if (opts.since) { sql += " AND ts >= ?"; args.push(opts.since); }
    sql += " ORDER BY id DESC LIMIT ?";
    args.push(limit);
    return (this.db.prepare(sql).all(...args) as EventRow[]).reverse();
  }

  /** 短期记忆的“整理进度”：睡觉或翻看之后，这个 id 之前的事件算是整理过了 */
  get sortedUpto(): number {
    return Number(this.get("sorted_upto", "0"));
  }

  markSorted(eventId: number) {
    if (eventId > this.sortedUpto) this.put("sorted_upto", eventId);
  }

  unsortedCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE id > ?").get(this.sortedUpto) as { n: number }).n;
  }

  /** 还没整理、但已经掉出眼前（最近 window 条）的事件，从早到晚 */
  unsortedOutOfView(window: number, limit = 60): EventRow[] {
    const newest = this.db.prepare("SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?").get(window - 1) as { id: number } | undefined;
    if (!newest) return [];
    return this.db.prepare("SELECT * FROM events WHERE id > ? AND id < ? ORDER BY id LIMIT ?")
      .all(this.sortedUpto, newest.id, limit) as EventRow[];
  }

  maxEventId(): number {
    return (this.db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM events").get() as { n: number }).n;
  }

  // ---------- 长期记忆 ----------
  // 记忆都是她的：在任何场合都能想起，说不说由她自己决定（DESIGN.md 10.6）。

  remember(content: string, opts: { kind?: string; about?: string | null; channel?: string; private?: boolean; importance?: number } = {}): number {
    const importance = Math.max(1, Math.min(5, opts.importance ?? 3));
    const info = this.db.prepare(
      "INSERT INTO memories (ts, content, kind, about, channel, private, importance) VALUES (?,?,?,?,?,?,?)",
    ).run(now(), content, opts.kind ?? "event", opts.about ?? null, opts.channel ?? "self", opts.private ? 1 : 0, importance);
    return Number(info.lastInsertRowid);
  }

  search(query: string, limit = 8, includeFaded = false): MemoryRow[] {
    const terms = query.split(/\s+/).filter(Boolean);
    if (!terms.length) terms.push(query);
    let sql = `SELECT * FROM memories WHERE (${terms.map(() => "content LIKE ?").join(" OR ")})`;
    if (!includeFaded) sql += " AND faded = 0";
    const rows = this.db.prepare(sql).all(...terms.map((t) => `%${t}%`)) as MemoryRow[];

    const t = now();
    const score = (r: MemoryRow) => {
      const hits = terms.filter((term) => r.content.includes(term)).length;
      const recency = 1 / (1 + (t - r.ts) / 86400 / 7);
      return hits * 3 + r.importance + recency * 2 + Math.min(r.access_count, 5) * 0.3;
    };
    const top = rows.sort((a, b) => score(b) - score(a)).slice(0, limit);
    this.touch(top.map((r) => r.id));
    return top;
  }

  aboutPerson(person: string, limit = 10): MemoryRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM memories WHERE about = ? AND faded = 0 ORDER BY importance DESC, ts DESC LIMIT ?",
    ).all(person, limit) as MemoryRow[];
    this.touch(rows.map((r) => r.id));
    return rows;
  }

  memoriesSince(since: number): MemoryRow[] {
    return this.db.prepare("SELECT * FROM memories WHERE ts >= ? ORDER BY ts").all(since) as MemoryRow[];
  }

  /** 遗忘：一个月没被想起过、本来也不太重要的记忆，慢慢淡去（不删除，只是不再被想起） */
  forgetStale() {
    const cutoff = now() - 30 * 86400;
    this.db.prepare(
      "UPDATE memories SET faded = 1 WHERE faded = 0 AND importance <= 2 AND ts < ? AND (last_accessed IS NULL OR last_accessed < ?)",
    ).run(cutoff, cutoff);
  }

  private touch(ids: number[]) {
    const stmt = this.db.prepare("UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?");
    const t = now();
    this.db.transaction(() => ids.forEach((id) => stmt.run(t, id)))();
  }

  // ---------- 兴趣线头 ----------

  threads(statuses: string[] = ["active"]): ThreadRow[] {
    return this.db.prepare(`SELECT * FROM threads WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY updated DESC`)
      .all(...statuses) as ThreadRow[];
  }

  addThread(title: string, note = ""): number {
    const t = now();
    return Number(this.db.prepare("INSERT INTO threads (created, updated, title, note) VALUES (?,?,?,?)").run(t, t, title, note).lastInsertRowid);
  }

  updateThread(threadId: number, note?: string | null, status?: string | null): boolean {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId) as ThreadRow | undefined;
    if (!row) return false;
    this.db.prepare("UPDATE threads SET note = ?, status = ?, updated = ?, touched = touched + 1 WHERE id = ?")
      .run(note ?? row.note, status || row.status, now(), threadId);
    return true;
  }

  // ---------- 认识的人 ----------

  seePerson(personId: string, name: string) {
    const t = now();
    this.db.prepare(
      "INSERT INTO people (id, name, first_met, last_seen) VALUES (?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen",
    ).run(personId, name, t, t);
  }

  person(personId: string): PersonRow | undefined {
    return this.db.prepare("SELECT * FROM people WHERE id = ?").get(personId) as PersonRow | undefined;
  }

  people(): PersonRow[] {
    return this.db.prepare("SELECT * FROM people ORDER BY last_seen DESC").all() as PersonRow[];
  }

  setPersonNotes(personId: string, notes: string) {
    this.db.prepare("UPDATE people SET notes = ? WHERE id = ?").run(notes, personId);
  }

  setPronoun(personId: string, pronoun: string) {
    this.db.prepare("UPDATE people SET pronoun = ? WHERE id = ?").run(pronoun, personId);
  }

  setDmOk(personId: string, ok: boolean) {
    this.db.prepare("UPDATE people SET dm_ok = ? WHERE id = ?").run(ok ? 1 : 0, personId);
  }

  // ---------- 收件箱 / 发件箱 ----------
  // 渠道（本地聊天、以后的 app、QQ）把消息放进 inbox；她的回复和主动消息放进 outbox，再由渠道取走

  pushInbox(channel: string, personId: string, name: string, content: string) {
    this.db.prepare("INSERT INTO inbox (ts, channel, person_id, name, content) VALUES (?,?,?,?,?)")
      .run(now(), channel, personId, name, content);
  }

  takeInbox(): InboxRow[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM inbox WHERE taken = 0 ORDER BY id").all() as InboxRow[];
      const mark = this.db.prepare("UPDATE inbox SET taken = 1 WHERE id = ?");
      rows.forEach((r) => mark.run(r.id));
      return rows;
    })();
  }

  queueMessage(toPerson: string, content: string, kind: "outreach" | "reply" = "outreach") {
    this.db.prepare("INSERT INTO outbox (ts, to_person, content, kind) VALUES (?,?,?,?)").run(now(), toPerson, content, kind);
  }

  /** 今天主动找了这个人几次（回复不算） */
  sentToday(toPerson: string): number {
    return (this.db.prepare(
      "SELECT COUNT(*) AS n FROM outbox WHERE to_person = ? AND kind = 'outreach' AND ts >= ?",
    ).get(toPerson, startOfToday()) as { n: number }).n;
  }

  takeOutbox(toPerson: string): OutboxRow[] {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM outbox WHERE to_person = ? AND delivered = 0 ORDER BY ts").all(toPerson) as OutboxRow[];
      const mark = this.db.prepare("UPDATE outbox SET delivered = 1 WHERE id = ?");
      rows.forEach((r) => mark.run(r.id));
      return rows;
    })();
  }

  // ---------- 杂项状态 ----------

  get(key: string): string | undefined;
  get(key: string, fallback: string): string;
  get(key: string, fallback?: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : fallback;
  }

  put(key: string, value: string | number) {
    this.db.prepare("INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, String(value));
  }

  // ---------- 自我档案 ----------

  readSelf(): string {
    return fs.readFileSync(config.selfPath, "utf-8");
  }

  /** 每次改写前留一份历史，这样能回看她是怎么一点点变过来的 */
  writeSelf(text: string) {
    const history = path.join(config.dataDir, "self_history");
    fs.mkdirSync(history, { recursive: true });
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    fs.writeFileSync(path.join(history, `${stamp}.md`), this.readSelf(), "utf-8");
    fs.writeFileSync(config.selfPath, text, "utf-8");
  }
}
