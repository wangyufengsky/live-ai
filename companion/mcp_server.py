"""把她的工具包成一个 MCP 服务器，给 Claude Code 后端用。

Claude Code 每次思考时会以子进程方式启动它；当前场合等信息通过环境变量传进来：
    COMPANION_CHANNEL   self / dm:<person> / group:<id>
    COMPANION_OUTREACH  1 = 允许主动发消息
    COMPANION_EXCLUDE   逗号分隔，这次不给她用的工具
"""

import asyncio
import os

import mcp.types as types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from .store import Store
from .tools import Ctx, run_tool, tool_specs

store = Store()
ctx = Ctx(store,
          channel=os.environ.get("COMPANION_CHANNEL", "self"),
          allow_outreach=os.environ.get("COMPANION_OUTREACH", "1") == "1")
exclude = tuple(t for t in os.environ.get("COMPANION_EXCLUDE", "").split(",") if t)

server = Server("mind")


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [types.Tool(name=s["name"], description=s["description"], inputSchema=s["input_schema"])
            for s in tool_specs(exclude=exclude, web=None)]


@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[types.TextContent]:
    if name in exclude:
        raise ValueError(f"现在不能用 {name}。")
    output, is_error = run_tool(ctx, name, arguments or {})
    if is_error:
        raise ValueError(output)  # MCP 会把异常作为 isError 的结果交给模型
    return [types.TextContent(type="text", text=output)]


async def main():
    async with stdio_server() as (read, write):
        await server.run(read, write, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
