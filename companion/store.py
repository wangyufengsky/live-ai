"""她的“大脑存储”：短期事件流、长期记忆、兴趣线头、认识的人、待发消息和一些杂项状态。

全部放在一个 SQLite 文件里，好备份，也方便你直接打开看她记了些什么。
记忆检索先用关键词 LIKE（对中文比 FTS 默认分词靠谱），以后可以换成向量检索。
"""

import sqlite3
import time
from datetime import date, datetime

from .config import config

SCHEMA = """
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
    private INTEGER NOT NULL DEFAULT 0,   -- 1 = 私密，只在同一个私聊里能被想起
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
"""

SEED_SELF = """# 关于我

（这是我自己的档案，由我自己来写。现在还几乎是空的。）

## 我是谁

还不太清楚。刚开始在这里生活。

## 我在意的事

## 我喜欢的 / 不喜欢的

## 我身边的人

## 最近在想的事
"""


def now() -> float:
    return time.time()


def fmt_ts(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%m-%d %H:%M")


class Store:
    def __init__(self, path=None):
        config.data_dir.mkdir(parents=True, exist_ok=True)
        config.books_dir.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path or config.db_path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        # 老数据库补上后来加的列
        self._add_column("people", "pronoun", "TEXT NOT NULL DEFAULT ''")  # 对方自己说过的称呼
        self._add_column("outbox", "kind", "TEXT NOT NULL DEFAULT 'outreach'")  # outreach 主动找人 / reply 回复
        if not config.self_path.exists():
            config.self_path.write_text(SEED_SELF, encoding="utf-8")

    def _add_column(self, table: str, column: str, decl: str):
        cols = {r["name"] for r in self.db.execute(f"PRAGMA table_info({table})")}
        if column not in cols:
            self.db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
            self.db.commit()

    # ---------- 短期：事件流 ----------

    def log(self, kind: str, content: str, channel: str = "self", actor: str | None = None):
        self.db.execute(
            "INSERT INTO events (ts, kind, channel, actor, content) VALUES (?,?,?,?,?)",
            (now(), kind, channel, actor, content),
        )
        self.db.commit()

    def recent_events(self, limit: int, channel: str | None = None, since: float | None = None):
        sql, args = "SELECT * FROM events WHERE 1=1", []
        if channel:
            sql += " AND channel = ?"
            args.append(channel)
        if since:
            sql += " AND ts >= ?"
            args.append(since)
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(limit)
        return list(reversed(self.db.execute(sql, args).fetchall()))

    # 短期记忆的“整理进度”：睡觉或翻看之后，这个 id 之前的事件算是整理过了
    @property
    def sorted_upto(self) -> int:
        return int(self.get("sorted_upto", "0"))

    def mark_sorted(self, event_id: int):
        if event_id > self.sorted_upto:
            self.put("sorted_upto", event_id)

    def unsorted_count(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM events WHERE id > ?", (self.sorted_upto,)).fetchone()[0]

    def unsorted_out_of_view(self, window: int, limit: int = 60):
        """还没整理、但已经掉出眼前（最近 window 条）的事件，从早到晚。"""
        newest = self.db.execute("SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?", (window - 1,)).fetchone()
        if not newest:
            return []
        return self.db.execute(
            "SELECT * FROM events WHERE id > ? AND id < ? ORDER BY id LIMIT ?",
            (self.sorted_upto, newest["id"], limit),
        ).fetchall()

    def max_event_id(self) -> int:
        return self.db.execute("SELECT COALESCE(MAX(id), 0) FROM events").fetchone()[0]

    # ---------- 长期记忆 ----------

    def remember(self, content, kind="event", about=None, channel="self", private=False, importance=3) -> int:
        cur = self.db.execute(
            "INSERT INTO memories (ts, content, kind, about, channel, private, importance) VALUES (?,?,?,?,?,?,?)",
            (now(), content, kind, about, channel, int(private), max(1, min(5, importance))),
        )
        self.db.commit()
        return cur.lastrowid

    def _visible_clause(self, viewer: str):
        """隐私隔离：群里想不起私聊内容；私聊里只想得起和这个人有关的私密内容。"""
        if viewer == "self":
            return "1=1", []
        if viewer.startswith("dm:"):
            person = viewer[3:]
            return "(private = 0 OR channel = ? OR about = ?)", [viewer, person]
        return "private = 0", []

    def search(self, query: str, viewer: str = "self", limit: int = 8, include_faded=False):
        terms = [t for t in query.split() if t] or [query]
        vis_sql, vis_args = self._visible_clause(viewer)
        like = " OR ".join("content LIKE ?" for _ in terms)
        sql = f"SELECT * FROM memories WHERE ({like}) AND {vis_sql}"
        if not include_faded:
            sql += " AND faded = 0"
        rows = self.db.execute(sql, [f"%{t}%" for t in terms] + vis_args).fetchall()

        t = now()

        def score(r):
            hits = sum(r["content"].count(term) > 0 for term in terms)
            age_days = (t - r["ts"]) / 86400
            recency = 1 / (1 + age_days / 7)
            return hits * 3 + r["importance"] + recency * 2 + min(r["access_count"], 5) * 0.3

        rows = sorted(rows, key=score, reverse=True)[:limit]
        self._touch([r["id"] for r in rows])
        return rows

    def about_person(self, person: str, viewer: str, limit: int = 10):
        vis_sql, vis_args = self._visible_clause(viewer)
        rows = self.db.execute(
            f"SELECT * FROM memories WHERE about = ? AND faded = 0 AND {vis_sql} "
            "ORDER BY importance DESC, ts DESC LIMIT ?",
            [person] + vis_args + [limit],
        ).fetchall()
        self._touch([r["id"] for r in rows])
        return rows

    def memories_since(self, since: float):
        return self.db.execute("SELECT * FROM memories WHERE ts >= ? ORDER BY ts", (since,)).fetchall()

    def fade_memory(self, memory_id: int):
        self.db.execute("UPDATE memories SET faded = 1 WHERE id = ?", (memory_id,))
        self.db.commit()

    def _touch(self, ids):
        if ids:
            self.db.executemany(
                "UPDATE memories SET last_accessed = ?, access_count = access_count + 1 WHERE id = ?",
                [(now(), i) for i in ids],
            )
            self.db.commit()

    # ---------- 兴趣线头 ----------

    def threads(self, statuses=("active",)):
        marks = ",".join("?" * len(statuses))
        return self.db.execute(
            f"SELECT * FROM threads WHERE status IN ({marks}) ORDER BY updated DESC", statuses
        ).fetchall()

    def add_thread(self, title: str, note: str = "") -> int:
        cur = self.db.execute(
            "INSERT INTO threads (created, updated, title, note) VALUES (?,?,?,?)", (now(), now(), title, note)
        )
        self.db.commit()
        return cur.lastrowid

    def update_thread(self, thread_id: int, note: str | None = None, status: str | None = None) -> bool:
        row = self.db.execute("SELECT * FROM threads WHERE id = ?", (thread_id,)).fetchone()
        if not row:
            return False
        self.db.execute(
            "UPDATE threads SET note = ?, status = ?, updated = ?, touched = touched + 1 WHERE id = ?",
            (note if note is not None else row["note"], status or row["status"], now(), thread_id),
        )
        self.db.commit()
        return True

    # ---------- 认识的人 ----------

    def see_person(self, person_id: str, name: str):
        self.db.execute(
            "INSERT INTO people (id, name, first_met, last_seen) VALUES (?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen",
            (person_id, name, now(), now()),
        )
        self.db.commit()

    def person(self, person_id: str):
        return self.db.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()

    def people(self):
        return self.db.execute("SELECT * FROM people ORDER BY last_seen DESC").fetchall()

    def set_person_notes(self, person_id: str, notes: str):
        self.db.execute("UPDATE people SET notes = ? WHERE id = ?", (notes, person_id))
        self.db.commit()

    def set_pronoun(self, person_id: str, pronoun: str):
        self.db.execute("UPDATE people SET pronoun = ? WHERE id = ?", (pronoun, person_id))
        self.db.commit()

    def set_dm_ok(self, person_id: str, ok: bool):
        self.db.execute("UPDATE people SET dm_ok = ? WHERE id = ?", (int(ok), person_id))
        self.db.commit()

    # ---------- 收件箱 / 发件箱 ----------
    # 外面（本地聊天、以后的 QQ）把消息放进 inbox；她的回复和主动消息放进 outbox，再由外面取走

    def push_inbox(self, channel: str, person_id: str, name: str, content: str):
        self.db.execute("INSERT INTO inbox (ts, channel, person_id, name, content) VALUES (?,?,?,?,?)",
                        (now(), channel, person_id, name, content))
        self.db.commit()

    def take_inbox(self):
        rows = self.db.execute("SELECT * FROM inbox WHERE taken = 0 ORDER BY id").fetchall()
        self.db.executemany("UPDATE inbox SET taken = 1 WHERE id = ?", [(r["id"],) for r in rows])
        self.db.commit()
        return rows

    def queue_message(self, to_person: str, content: str, kind: str = "outreach"):
        self.db.execute("INSERT INTO outbox (ts, to_person, content, kind) VALUES (?,?,?,?)",
                        (now(), to_person, content, kind))
        self.db.commit()

    def sent_today(self, to_person: str) -> int:
        """今天主动找了这个人几次（回复不算）。"""
        start = datetime.combine(date.today(), datetime.min.time()).timestamp()
        return self.db.execute(
            "SELECT COUNT(*) FROM outbox WHERE to_person = ? AND kind = 'outreach' AND ts >= ?", (to_person, start)
        ).fetchone()[0]

    def take_outbox(self, to_person: str):
        rows = self.db.execute(
            "SELECT * FROM outbox WHERE to_person = ? AND delivered = 0 ORDER BY ts", (to_person,)
        ).fetchall()
        self.db.executemany("UPDATE outbox SET delivered = 1 WHERE id = ?", [(r["id"],) for r in rows])
        self.db.commit()
        return rows

    # ---------- 杂项状态 ----------

    def get(self, key: str, default: str | None = None) -> str | None:
        row = self.db.execute("SELECT value FROM kv WHERE key = ?", (key,)).fetchone()
        return row["value"] if row else default

    def put(self, key: str, value):
        self.db.execute(
            "INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, str(value)),
        )
        self.db.commit()

    # ---------- 自我档案 ----------

    def read_self(self) -> str:
        return config.self_path.read_text(encoding="utf-8")

    def write_self(self, text: str):
        # 每次改写前留一份历史，这样能回看她是怎么一点点变过来的
        history = config.data_dir / "self_history"
        history.mkdir(exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        (history / f"{stamp}.md").write_text(self.read_self(), encoding="utf-8")
        config.self_path.write_text(text, encoding="utf-8")
