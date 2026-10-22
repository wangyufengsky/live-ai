"""大脑：本机已登录的 Claude Code（claude -p），用你自己的订阅额度。

她的工具由 mcp_server.py 以 MCP 提供。只适合你自己在本地陪她：
订阅额度按“个人日常使用”设计，不能拿来替别人（比如 QQ 群里的人）调用。
"""

import json
import os
import subprocess
import sys

from ..config import ROOT, config
from ..energy import Energy
from ..prompts import SYSTEM
from ..tools import Ctx, brief


def think(ctx: Ctx, brain: dict, prompt: str, effort: str, max_steps: int, exclude, web: bool) -> str:
    mcp_config = {"mcpServers": {"mind": {
        "command": sys.executable,
        "args": ["-m", "companion.mcp_server"],
        "cwd": str(ROOT),
        "env": {
            "COMPANION_DATA_DIR": str(config.data_dir),
            "COMPANION_CHANNEL": ctx.channel,
            "COMPANION_OUTREACH": "1" if ctx.allow_outreach else "0",
            "COMPANION_EXCLUDE": ",".join(exclude),
        },
    }}}
    builtin = "WebSearch,WebFetch" if web else ""
    cmd = [
        config.claude_bin, "-p", prompt,
        "--system-prompt", SYSTEM,
        "--model", brain["model"],
        "--effort", effort,
        "--output-format", "stream-json", "--verbose",
        "--mcp-config", json.dumps(mcp_config, ensure_ascii=False), "--strict-mcp-config",
        # 只给她自己的工具和上网，不给 Claude Code 自带的读写文件、跑命令
        "--tools", builtin,
        "--allowedTools", "mcp__mind__*" + ("," + builtin if builtin else ""),
        # 不加载你自己的 Claude Code 设置、CLAUDE.md 和插件
        "--setting-sources", "",
        "--no-session-persistence",
    ]
    env = {**os.environ, "PYTHONPATH": str(ROOT)}
    proc = subprocess.Popen(cmd, cwd=config.data_dir, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    result, energy = None, Energy(ctx.store)
    for line in proc.stdout:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "assistant":
            for block in event.get("message", {}).get("content", []):
                if block.get("type") == "tool_use" and block.get("name") in ("WebSearch", "WebFetch"):
                    ctx.store.log("did", f"{block['name']}: {brief(block.get('input', {}))}",
                                  ctx.channel, actor="me")
        elif event.get("type") == "result":
            result = event
    stderr = proc.stderr.read()
    proc.wait()

    if result is None:
        raise RuntimeError(f"Claude Code 没有返回结果：{stderr.strip()[-500:]}")
    usage = result.get("usage", {})
    energy.spend(usage.get("input_tokens", 0), usage.get("output_tokens", 0),
                 usage.get("cache_creation_input_tokens", 0), usage.get("cache_read_input_tokens", 0))
    if result.get("is_error"):
        raise RuntimeError(f"Claude Code 出错：{result.get('result') or stderr.strip()[-500:]}")
    return (result.get("result") or "").strip()
