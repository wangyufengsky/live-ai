"""她的一天：醒来、和人聊天、睡觉。run_forever 把这些串成一个持续的、由事件驱动的生活。"""

import random
import time
from datetime import date, datetime

from . import prompts
from .config import config
from .mind import Energy, think
from .perception import WEEKDAYS, perceive
from .store import Store, fmt_ts, now
from .tools import Ctx


def _now_text() -> str:
    d = datetime.now()
    return f"{d:%Y-%m-%d %H:%M}，星期{WEEKDAYS[d.weekday()]}"


def _fmt_events(rows) -> str:
    if not rows:
        return "（没什么）"
    who = {"heard": "", "said": "我说", "did": "我做了", "thought": "我想", "read": "我在读", "system": "（注意到）"}
    lines = []
    for r in rows:
        actor = r["actor"] if r["kind"] == "heard" else who.get(r["kind"], r["kind"])
        where = "" if r["channel"] == "self" else f"[{r['channel']}] "
        lines.append(f"{fmt_ts(r['ts'])} {where}{actor}：{r['content']}")
    return "\n".join(lines)


def _fmt_threads(store: Store) -> str:
    rows = store.threads(("active", "resting"))
    if not rows:
        return "（还没有）"
    return "\n".join(f"#{r['id']} [{r['status']}] {r['title']} —— {r['note'] or ''}" for r in rows)


def _pronoun(p) -> str:
    return p["pronoun"] or "ta（对方没说过，不要猜）"


def _fmt_people(store: Store) -> str:
    rows = store.people()
    if not rows:
        return "（还没认识谁）"
    return "\n".join(
        f"{r['name']}（id={r['id']}，称呼：{_pronoun(r)}，上次见 {fmt_ts(r['last_seen'])}，"
        f"{'可以主动找 ta' if r['dm_ok'] else '还没同意被主动私聊'}）：{r['notes'] or '（还没写印象）'}"
        for r in rows
    )


def _overflow_note(store: Store) -> str:
    """短期记忆快装不下时提醒她。眼前只看得到最近 recent_events 条，更早的没整理就会被忘掉。"""
    window = config.recent_events
    pending = store.unsorted_count()
    lost = len(store.unsorted_out_of_view(window))
    if lost:
        return (f"\n【提醒】还有 {lost} 件更早的事没整理，已经不在眼前了。"
                "想翻看的话用 review_unsorted，值得留下的记一下。")
    if pending >= window * 0.75:
        return "\n【提醒】最近的事有点多了，再不整理，早一些的就要记不清了。"
    return ""


def wake(store: Store) -> str:
    perceive(store)
    energy = Energy(store)
    if energy.percent <= 5:
        store.log("thought", "太累了，今天就先这样吧。")
        return ""
    last = store.get("last_wake")
    since = ""
    if last:
        hours = (now() - float(last)) / 3600
        since = f"上次醒来是 {hours:.1f} 小时前。"
    store.put("last_wake", now())

    prompt = prompts.WAKE.format(
        now=_now_text(), since_last=since, energy=energy.percent,
        self_md=store.read_self(), threads=_fmt_threads(store),
        events=_fmt_events(store.recent_events(config.recent_events)),
        people=_fmt_people(store), overflow=_overflow_note(store),
    )
    thought = think(Ctx(store), prompt, config.effort_wake)
    if thought:
        store.log("thought", thought)
    return thought


def chat(store: Store, person_id: str, name: str, messages: str | list[str]) -> str:
    """回应某个人。连着发来的几条消息会一起交给她，就像人看到一串消息再一起回。"""
    messages = [messages] if isinstance(messages, str) else messages
    perceive(store)
    store.see_person(person_id, name)
    channel = f"dm:{person_id}"
    for m in messages:
        store.log("heard", m, channel, actor=name)

    energy = Energy(store)
    p = store.person(person_id)
    prompt = prompts.CHAT.format(
        now=_now_text(), energy=energy.percent,
        tired="你有点累了，说话可以简短些。" if energy.percent < 15 else "",
        self_md=store.read_self(), name=name,
        person=f"id={person_id}，称呼：{_pronoun(p)}。我的印象：{p['notes'] or '（还没写）'}",
        own_recent=_fmt_events(store.recent_events(6, channel="self")),
        history=_fmt_events(store.recent_events(20 + len(messages), channel=channel)[:-len(messages)]),
        message="\n".join(messages),
    )
    ctx = Ctx(store, channel=channel)
    reply = think(ctx, prompt, config.effort_chat, max_steps=6, exclude=("rewrite_self",))
    if reply:
        store.log("said", reply, channel, actor="me")
    return reply


def sleep(store: Store) -> str:
    since = float(store.get("last_sleep", str(now() - 86400)))
    upto = store.max_event_id()
    memories = store.memories_since(since)
    prompt = prompts.SLEEP.format(
        now=_now_text(), self_md=store.read_self(), threads=_fmt_threads(store),
        events=_fmt_events(store.recent_events(200, since=since)),
        memories="\n".join(f"#{m['id']}: {m['content']}" for m in memories) or "（什么都没记）",
    )
    # 睡觉时不上网、不找人，只整理自己
    diary = think(Ctx(store, allow_outreach=False), prompt, config.effort_sleep,
                  max_steps=20, exclude=("send_message",), web=False)
    if diary:
        store.remember(diary, kind="feeling", importance=3)
        store.log("thought", f"（日记）{diary}")
    store.mark_sorted(upto)
    _forget(store)
    store.put("last_sleep", now())
    store.put("last_sleep_date", date.today().isoformat())
    Energy(store).reset()
    return diary


def _forget(store: Store):
    """遗忘：一个月没被想起过、本来也不太重要的记忆，慢慢淡去（不删除，只是不再被想起）。"""
    cutoff = now() - 30 * 86400
    store.db.execute(
        "UPDATE memories SET faded = 1 WHERE faded = 0 AND importance <= 2 AND ts < ? "
        "AND (last_accessed IS NULL OR last_accessed < ?)",
        (cutoff, cutoff),
    )
    store.db.commit()


# ---------- 持续生活 ----------

def is_alive(store: Store) -> bool:
    """有没有一个 run_forever 正在跑（本地聊天靠这个决定是排队还是直接回）。"""
    return now() - float(store.get("alive_at", "0")) < 10


def _quiet() -> bool:
    start, end = config.quiet_hours
    return start <= datetime.now().hour < end


def _schedule_wake(store: Store, minutes: tuple[int, int] | None = None) -> float:
    at = now() + random.randint(*(minutes or config.wake_interval_min)) * 60
    store.put("next_wake", at)
    return at


def handle_inbox(store: Store, log=print) -> bool:
    """把收件箱里的消息按人分组，一个人一个人地回。有消息就返回 True。"""
    batch = store.take_inbox()
    if not batch:
        return False
    by_channel: dict[str, list] = {}
    for row in batch:
        by_channel.setdefault(row["channel"], []).append(row)
    for channel, rows in by_channel.items():
        person_id, name = rows[-1]["person_id"], rows[-1]["name"]
        texts = [r["content"] for r in rows]
        if not channel.startswith("dm:"):
            continue  # 群聊在 2c 里做
        log(f"[{_now_text()}] {name}：{' / '.join(texts)}")
        reply = chat(store, person_id, name, texts)
        if reply:
            store.queue_message(person_id, reply, kind="reply")
            log(f"[{_now_text()}] 她 → {name}：{reply}")
    return True


def step(store: Store, log=print) -> bool:
    """生活循环的一拍。一次只做一件事：有人找先回人，然后是睡觉，然后是自己的时间。
    做了事返回 True，闲着返回 False。"""
    store.put("alive_at", now())
    perceive(store)
    if handle_inbox(store, log):
        return True
    if datetime.now().hour >= config.sleep_hour and store.get("last_sleep_date") != date.today().isoformat():
        # 用 >= 而不是 ==：错过了整点也会补上
        log(f"[{_now_text()}] 睡觉中……")
        log(f"日记：{sleep(store)}")
        return True
    if now() >= float(store.get("next_wake", "0")):
        _schedule_wake(store)
        if not _quiet():
            log(f"[{_now_text()}] 醒来")
            log(f"念头：{wake(store)}")
            return True
    return False


def run_forever(store: Store, log=print, tick: float = 2.0):
    log("她开始生活了。Ctrl+C 停止。")
    if not store.get("last_sleep_date"):
        store.put("last_sleep_date", date.today().isoformat())  # 第一天不用一上来就睡
    if float(store.get("next_wake", "0")) < now():
        _schedule_wake(store, (1, 5))  # 刚开始，过几分钟先醒一次
    log(f"下次醒来约在 {datetime.fromtimestamp(float(store.get('next_wake'))):%H:%M}")
    while True:
        if not step(store, log):
            time.sleep(tick)
