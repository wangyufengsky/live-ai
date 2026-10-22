"""大脑：Claude API，需要 ANTHROPIC_API_KEY。"""

import anthropic

from ..energy import Energy
from ..prompts import SYSTEM
from ..tools import Ctx, brief, run_tool, tool_specs


def think(ctx: Ctx, brain: dict, prompt: str, effort: str, max_steps: int, exclude, web: bool) -> str:
    client = anthropic.Anthropic()
    energy = Energy(ctx.store)
    tools = tool_specs(exclude=exclude, web="anthropic" if web else None)
    offered = {t["name"] for t in tools}
    messages = [{"role": "user", "content": prompt}]
    response = None

    for _ in range(max_steps):
        response = client.beta.messages.create(
            model=brain["model"],
            max_tokens=16000,
            system=SYSTEM,
            tools=tools,
            messages=messages,
            output_config={"effort": effort},
            cache_control={"type": "ephemeral"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        u = response.usage
        energy.spend(u.input_tokens, u.output_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens)
        messages.append({"role": "assistant", "content": response.content})
        for block in response.content:
            if block.type == "server_tool_use":
                ctx.store.log("did", f"{block.name}: {brief(block.input)}", ctx.channel, actor="me")

        if response.stop_reason == "refusal":
            ctx.store.log("system", "这次的思考被安全机制中止了。", ctx.channel)
            return ""
        if response.stop_reason == "pause_turn":
            continue  # 服务端工具（搜索）还没跑完，原样续上
        if response.stop_reason != "tool_use":
            break

        results = []
        for block in response.content:
            if block.type != "tool_use":
                continue
            output, is_error = (run_tool(ctx, block.name, block.input) if block.name in offered
                                else (f"现在不能用 {block.name}。", True))
            results.append({"type": "tool_result", "tool_use_id": block.id,
                            "content": output, "is_error": is_error})
        messages.append({"role": "user", "content": results})

    if response is None:
        return ""
    return "".join(b.text for b in response.content if b.type == "text").strip()
