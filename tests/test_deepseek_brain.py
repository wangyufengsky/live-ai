"""DeepSeek（openai_compat）大脑的冒烟测试：假的 OpenAI 客户端，检查 reasoning_content 回传、工具执行、精力。"""
import json, os, sys, tempfile
from pathlib import Path
from types import SimpleNamespace as NS
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ["COMPANION_DATA_DIR"] = tempfile.mkdtemp()
os.environ["DEEPSEEK_API_KEY"] = "test"
from openai.types.chat import ChatCompletion
from companion.config import config
from companion.brains import openai_compat
from companion import life
from companion.store import Store

def completion(content="", reasoning=None, calls=(), finish="stop"):
    msg = {"role": "assistant", "content": content}
    if reasoning: msg["reasoning_content"] = reasoning
    if calls:
        msg["tool_calls"] = [{"id": f"c{i}", "type": "function", "function": {"name": n, "arguments": json.dumps(a, ensure_ascii=False)}} for i, (n, a) in enumerate(calls)]
        finish = "tool_calls"
    return ChatCompletion.model_validate({"id": "x", "object": "chat.completion", "created": 0, "model": "deepseek-flash",
        "choices": [{"index": 0, "message": msg, "finish_reason": finish}],
        "usage": {"prompt_tokens": 1000, "completion_tokens": 100, "total_tokens": 1100, "prompt_cache_hit_tokens": 800}})

script, seen = [], []
class FakeOpenAI:
    def __init__(self, api_key, base_url):
        assert base_url == "https://api.deepseek.com"
        self.chat = NS(completions=NS(create=self.create))
    def create(self, **kw):
        seen.append(json.loads(json.dumps(kw, default=str)))
        return script.pop(0)
openai_compat.OpenAI = FakeOpenAI

store = Store()
(config.books_dir / "b.txt").write_text("一二三" * 2000, encoding="utf-8")
script[:] = [
    completion(reasoning="先看看书架", calls=[("list_books", {}), ("web_fetch", {"url": "http://127.0.0.1:3000/send"})]),
    completion(reasoning="读一下", calls=[("read_book", {"name": "b.txt"}), ("rewrite_self", {"content": "# 我\n叫小一"}), ("no_such", {})]),
    completion(content="读了点书，给自己取了个名字。", reasoning="好了"),
]
print("WAKE ->", life.wake(store))
req = seen[0]
assert req["model"] == "deepseek-flash" and req["reasoning_effort"] == "high"
assert req["messages"][0]["role"] == "system"
names = [t["function"]["name"] for t in req["tools"]]
assert "web_fetch" in names and "web_search" not in names, names
# 第二次请求必须带回第一轮的 reasoning_content
assert seen[1]["messages"][2]["reasoning_content"] == "先看看书架"
assert seen[2]["messages"][2]["reasoning_content"] == "先看看书架"
tool_msgs = [m for m in seen[2]["messages"] if m["role"] == "tool"]
print("  tool results:", [m["content"][:30] for m in tool_msgs])
assert "本机或局域网" in tool_msgs[1]["content"]          # localhost 被挡
assert "不能用 no_such" in tool_msgs[-1]["content"]
assert "小一" in store.read_self()
print("  energy:", store.get("energy_used"))  # 3*(200 + 100 + 80) = 1140
assert int(store.get("energy_used")) == 3 * (200 + 100 + 800 // 10)

# 睡觉时不给上网、不给发消息
script[:] = [completion(content="日记")]
life.sleep(store)
names = [t["function"]["name"] for t in seen[-1]["tools"]]
assert "web_fetch" not in names and "send_message" not in names
print("ALL OK")
