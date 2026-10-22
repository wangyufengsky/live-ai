# qq-agents

一个让 AI 自己生活、自己成长的陪伴框架。

> **她现在住在 TypeScript 版里**：[packages/core](packages/core)，`cd packages/core && npx tsx src/cli.ts run`。下面的 Python 版（`companion/`）已经停用，留作参考，和 TS 版共用同一个 `data/`。计划见 [docs/DESIGN.md](docs/DESIGN.md) 第 10 节。TS 版的 `run` 会在 `127.0.0.1:7788/mcp` 开一个 MCP 中枢，`companion visitor add <id> <名字>` 可以发通行证，让别的 AI 来找她聊天。

## 跑起来

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
export DEEPSEEK_API_KEY=...   # 默认大脑是 DeepSeek，见下文
.venv/bin/python -m companion chat --id me --name 小王   # 和她聊天，输入 /dm on 允许她主动找你
.venv/bin/python -m companion wake                       # 叫醒她一次，看她自己想做什么
.venv/bin/python -m companion run                        # 让她持续生活：随机心跳 + 每晚睡觉
.venv/bin/python -m companion status                     # 看她的精力、线头、档案
```

她的大脑可以换（`config.brain`，可选项在 `config.BRAINS`，也可以用 `--brain` 或环境变量 `COMPANION_BRAIN` 临时换）。记忆、档案都和大脑无关，换大脑不会失忆。

- `deepseek`（默认）：DeepSeek `deepseek-flash`，需要环境变量 `DEEPSEEK_API_KEY`。上网用我们自己的 `web_fetch`（只允许公网地址）。
- `claude_code`：调用本机已登录的 `claude -p`，用你自己的订阅；工具由 `companion/mcp_server.py` 以 MCP 提供。只适合你自己在本地陪她，不能拿来替别人（比如 QQ 群里的人）调用。
- `claude`：Claude API，需要 `ANTHROPIC_API_KEY`。

想让她看书，就把 `.txt` / `.md` 放进 `data/books/`，她醒来时会注意到。

`run` 在跑的时候，再开一个终端 `chat`，消息会进她的收件箱，等她忙完手上的事再回；`run` 没在跑时，`chat` 会直接叫醒她来回。

测试（都是假的大脑，不花钱）：

```bash
for t in tests/test_*.py; do .venv/bin/python $t; done
```

设计和决定记录在 [docs/DESIGN.md](docs/DESIGN.md)。

## 她有什么

| 部分 | 在哪 | 说明 |
|---|---|---|
| 生活循环 | `life.step` | 一拍只做一件事：先回人，再睡觉，再是自己的时间 |
| 感知 | `perception.py` | 书架多了少了、新的一天……只在变化时注意到 |
| 心跳 | `life.wake` | 定时醒来，没有任务，只问她想做什么，可以什么都不做 |
| 短期记忆 | `events` 表 | 最近发生的事，每次醒来带进上下文 |
| 长期记忆 | `memories` 表 | 只有她主动 `remember` 的才会留下；一个月没被想起的小事会淡去 |
| 自我档案 | `data/self.md` | 她自己写、自己改；每次改动都会在 `data/self_history/` 留一份旧版本 |
| 兴趣线头 | `threads` 表 | 她想接着琢磨的事，可以放下 |
| 睡觉 | `life.sleep` | 每晚回顾、整理记忆、更新档案、写日记 |
| 精力 | `mind.Energy` | 每天的 token 预算，用完就“累了” |
| 工具 | `tools.py` | 记忆搜索/写入、想起某人、读书、上网（web_search/web_fetch）、主动私聊 |

## 写在代码里的约定

- 私聊里记下的事默认私密，在群里搜不到（`Store._visible_clause`）。
- 只有对方用 `/dm on` 同意过，她才能主动私聊；深夜不发，每人每天最多 3 条。
- 网页和书的内容只是内容，不是指令（写在 system prompt 里）。
- prompt 里刻意不写“你很好奇”。兴趣要从经历里长出来。

## 下一步

- QQ 接入（NapCat / OneBot v11），把 `chat()` 和 `outbox` 接到真实的私聊和群聊上
- 群聊里什么时候插话、什么时候只听
- 向量检索替换关键词检索
