"""生活循环、感知层、称呼、短期记忆溢出的测试。大脑是假的，不花钱。用法：python tests/test_life_loop.py"""
import os, sys, tempfile, time
from datetime import date, timedelta
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["COMPANION_DATA_DIR"] = tempfile.mkdtemp()

from companion import life
from companion.config import config
from companion.store import Store
from companion.tools import Ctx, run_tool

thoughts = []  # (ctx.channel, prompt)


def fake_think(ctx, prompt, effort, max_steps=None, exclude=(), web=True):
    thoughts.append((ctx.channel, prompt))
    return f"回复{len(thoughts)}"


life.think = fake_think
config.sleep_hour = 0
config.quiet_hours = (0, 0)
store = Store()
store.put("last_sleep_date", date.today().isoformat())
store.put("next_wake", time.time() + 3600)
logs = []
log = logs.append

# --- 感知层：书架多了、少了，新的一天 ---
(config.books_dir / "a.txt").write_text("甲", encoding="utf-8")
life.perceive(store)
(config.books_dir / "b.txt").write_text("乙", encoding="utf-8")
(config.books_dir / "a.txt").unlink()
store.put("last_seen_date", (date.today() - timedelta(days=1)).isoformat())
noticed = life.perceive(store)
assert noticed[:2] == ["书架上多了一本书：b.txt", "书架上少了一本书：a.txt"], noticed
assert noticed[2].startswith("新的一天"), noticed
assert life.perceive(store) == []  # 没变化就不说话
print("perception OK")

# --- 收件箱：同一个人连发的合并，一个人一个人地回；回复不算主动找人 ---
store.push_inbox("dm:me", "me", "小王", "在吗")
store.push_inbox("dm:me", "me", "小王", "今天好累")
store.push_inbox("dm:x", "x", "小李", "你好")
assert life.step(store, log) is True
assert len(thoughts) == 2
assert "在吗\n今天好累" in thoughts[0][1] and thoughts[0][0] == "dm:me"
assert "称呼：ta（对方没说过，不要猜）" in thoughts[0][1]
replies = store.take_outbox("me")
assert [(r["kind"], r["content"]) for r in replies] == [("reply", "回复1")]
assert store.sent_today("me") == 0
print("inbox OK")

# --- 先回人，再做自己的事 ---
store.put("next_wake", 0)
store.push_inbox("dm:me", "me", "小王", "晚安")
life.step(store, log)
assert thoughts[-1][0] == "dm:me"
life.step(store, log)
assert thoughts[-1][0] == "self" and "现在没有人找你" in thoughts[-1][1]
assert float(store.get("next_wake")) > time.time()  # 醒过之后排好了下一次
assert life.step(store, log) is False  # 闲着
print("priority OK")

# --- 深夜不醒，但会排下一次 ---
config.quiet_hours = (0, 24)
store.put("next_wake", 0)
n = len(thoughts)
assert life.step(store, log) is False and len(thoughts) == n
assert float(store.get("next_wake")) > time.time()
config.quiet_hours = (0, 0)
print("quiet hours OK")

# --- 称呼：对方说过才记，之后都用这个 ---
ctx = Ctx(store, channel="dm:me")
assert run_tool(ctx, "set_pronoun", {"person_id": "me", "pronoun": "他"})[0] == "记住了，以后用“他”。"
assert "称呼：他" in life._fmt_people(store)
assert "称呼：ta（对方没说过，不要猜）" in life._fmt_people(store)  # 小李还没说过
print("pronoun OK")

# --- 短期记忆溢出：快满时提醒，掉出眼前的可以翻看，翻过就算整理过 ---
config.recent_events = 10
store.mark_sorted(store.max_event_id())
for i in range(8):
    store.log("thought", f"想法{i}")
assert "再不整理" in life._overflow_note(store)
for i in range(8, 20):
    store.log("thought", f"想法{i}")
note = life._overflow_note(store)
assert "10 件更早的事没整理" in note, note
out = run_tool(Ctx(store), "review_unsorted", {})[0]
assert "想法0" in out and "想法9" in out and "想法10" not in out, out
assert "更早的事" not in life._overflow_note(store)
store.put("next_wake", 0)
life.step(store, log)
assert "【提醒】" in thoughts[-1][1]
print("overflow OK")

# --- 睡觉后，今天的事都算整理过了 ---
store.put("last_sleep_date", "2000-01-01")
life.step(store, log)
assert "该睡觉了" in thoughts[-1][1]
assert store.unsorted_count() <= 1 and life._overflow_note(store) == ""
print("sleep OK")

# --- 本地聊天：有 run 在跑时走收件箱 ---
assert life.is_alive(store)
store.put("alive_at", 0)
assert not life.is_alive(store)
print("ALL OK")
