"""Claude API 大脑 + 生活流程的冒烟测试：假的 Anthropic 客户端，不花钱。用法：python tests/test_claude_brain.py"""
import os, sys, tempfile
from pathlib import Path
from types import SimpleNamespace as NS
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["COMPANION_DATA_DIR"] = tempfile.mkdtemp()
os.environ["COMPANION_BRAIN"] = "claude"

import anthropic
from companion import life
from companion.energy import Energy
from companion.store import Store

usage = NS(input_tokens=1000, output_tokens=200, cache_creation_input_tokens=0, cache_read_input_tokens=0)
tool = lambda _n, **inp: NS(type="tool_use", id=f"t_{_n}", name=_n, input=inp)
text = lambda t: NS(type="text", text=t)
script, calls = [], []

def fake_create(**kw):
    calls.append({**kw, "messages": list(kw["messages"])})
    stop, content = script.pop(0)
    return NS(stop_reason=stop, content=content, usage=usage)

anthropic.Anthropic = lambda: NS(beta=NS(messages=NS(create=fake_create)))

store = Store()
store.see_person("me", "小王")

# 醒来：挂线头、记东西、想私聊（对方还没同意）
script[:] = [
    ("tool_use", [tool("start_thread", title="山里的庙"), tool("remember", content="一个绕圈的故事", importance=2),
                  tool("send_message", person_id="me", content="你好呀")]),
    ("end_turn", [text("这个故事在绕圈。")]),
]
assert life.wake(store) == "这个故事在绕圈。"
req = calls[0]
assert req["model"] == "claude-opus-5-5" and req["fallbacks"] == "default"
names = [t["name"] for t in req["tools"]]
assert "web_search" in names and names.count("web_fetch") == 1, names   # 用自带的抓取，不用本地的
results = calls[1]["messages"][-1]["content"]
assert "还没同意" in results[2]["content"]

# 私聊里记下的事默认私密，群里想不起来
store.set_dm_ok("me", True)
script[:] = [("tool_use", [tool("remember", content="小王说最近工作很累", about="me", importance=4)]),
             ("end_turn", [text("辛苦啦。")])]
assert life.chat(store, "me", "小王", "今天有点累") == "辛苦啦。"
assert store.search("工作", viewer="group:1") == []
assert len(store.search("工作", viewer="dm:me")) == 1

# 睡觉：改档案、放下线头、精力恢复
script[:] = [("tool_use", [tool("rewrite_self", content="# 关于我\n\n好像喜欢绕圈的故事。"),
                           tool("update_thread", thread_id=1, status="dropped")]),
             ("end_turn", [text("今天读了点书。")])]
assert life.sleep(store) == "今天读了点书。"
assert "绕圈" in store.read_self() and store.threads(("active",)) == []
assert Energy(store).percent == 100

# pause_turn 会续上；refusal 直接停
script[:] = [("pause_turn", [text("")]), ("end_turn", [text("嗯。")])]
assert life.wake(store) == "嗯。"
script[:] = [("refusal", [])]
assert life.wake(store) == ""
print("ALL OK")
