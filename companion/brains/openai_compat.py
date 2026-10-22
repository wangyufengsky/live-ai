"""大脑：兼容 OpenAI 接口的模型（DeepSeek、GPT 等）。

DeepSeek 的两条规矩（见 api-docs.deepseek.com 的 thinking mode 一节）：
- 思考模式默认开启，用 reasoning_effort（low / high / max）调深浅
- 带工具时，之前每一轮的 reasoning_content 都要原样传回，否则会 400
"""

import json
import os

from openai import OpenAI

from ..energy import Energy
from ..prompts import SYSTEM
from ..tools import Ctx, run_tool, tool_specs


def think(ctx: Ctx, brain: dict, prompt: str, effort: str, max_steps: int, exclude, web: bool) -> str:
    key = os.environ.get(brain["key_env"])
    if not key:
        raise RuntimeError(f"没有设置环境变量 {brain['key_env']}")
    client = OpenAI(api_key=key, base_url=brain["base_url"])
    energy = Energy(ctx.store)

    specs = tool_specs(exclude=exclude, web="local" if web else None)
    tools = [{"type": "function", "function": {
        "name": s["name"], "description": s["description"], "parameters": s["input_schema"]}} for s in specs]
    offered = {s["name"] for s in specs}
    extra = {}
    if brain.get("effort_map"):
        extra["reasoning_effort"] = brain["effort_map"].get(effort, effort)

    messages = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}]
    msg = None
    for _ in range(max_steps):
        resp = client.chat.completions.create(model=brain["model"], messages=messages, tools=tools, **extra)
        _spend(energy, resp.usage)
        choice = resp.choices[0]
        msg = choice.message

        assistant = {"role": "assistant", "content": msg.content or ""}
        reasoning = (msg.model_extra or {}).get("reasoning_content")
        if reasoning:
            assistant["reasoning_content"] = reasoning
        if msg.tool_calls:
            assistant["tool_calls"] = [tc.model_dump(exclude_none=True) for tc in msg.tool_calls]
        messages.append(assistant)

        if choice.finish_reason == "content_filter":
            ctx.store.log("system", "这次的思考被内容审核中止了。", ctx.channel)
            return ""
        if not msg.tool_calls:
            break

        for tc in msg.tool_calls:
            name = tc.function.name
            try:
                args = json.loads(tc.function.arguments or "{}")
                output, is_error = (run_tool(ctx, name, args) if name in offered
                                    else (f"现在不能用 {name}。", True))
            except json.JSONDecodeError:
                output, is_error = "参数不是合法的 JSON。", True
            messages.append({"role": "tool", "tool_call_id": tc.id,
                             "content": f"[出错] {output}" if is_error else output})

    return ((msg.content if msg else "") or "").strip()


def _spend(energy: Energy, usage):
    if usage is None:
        return
    # DeepSeek 用 prompt_cache_hit_tokens，OpenAI 用 prompt_tokens_details.cached_tokens
    cached = (usage.model_extra or {}).get("prompt_cache_hit_tokens")
    if cached is None and usage.prompt_tokens_details:
        cached = usage.prompt_tokens_details.cached_tokens
    cached = cached or 0
    energy.spend(usage.prompt_tokens - cached, usage.completion_tokens, 0, cached)
