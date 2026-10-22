"""框架配置。所有可调的东西都放在这里，方便以后改成读环境变量或配置文件。"""

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 可选的大脑。kind 决定用哪个后端：
#   claude_code   本机已登录的 Claude Code（你的订阅）。只适合你自己在本地陪她，不能接 QQ 群替别人调用
#   anthropic     Claude API，需要 ANTHROPIC_API_KEY
#   openai_compat 兼容 OpenAI 接口的模型（DeepSeek、GPT 等），base_url + model + key
BRAINS = {
    "deepseek": {"kind": "openai_compat", "base_url": "https://api.deepseek.com",
                 "model": "deepseek-flash", "key_env": "DEEPSEEK_API_KEY",
                 # 我们的 effort 档位 → DeepSeek 的 reasoning_effort（只有 low / high / max）
                 "effort_map": {"low": "low", "medium": "high", "high": "high", "max": "max"}},
    "claude_code": {"kind": "claude_code", "model": "opus"},
    "claude": {"kind": "anthropic", "model": "claude-opus-5-5"},
}


@dataclass
class Config:
    data_dir: Path = Path(os.environ.get("COMPANION_DATA_DIR", ROOT / "data"))

    # 她用哪个大脑，对应下面 BRAINS 里的名字。每个居民（数据目录）可以用不同的大脑
    brain: str = os.environ.get("COMPANION_BRAIN", "deepseek")
    claude_bin: str = "claude"

    # 心跳和反思用 medium，聊天想更快可以调成 low
    effort_wake: str = "medium"
    effort_chat: str = "medium"
    effort_sleep: str = "high"

    # 每天的“精力”，单位是 token。用完了她就会“累”，只回消息不再主动做事
    daily_energy: int = 400_000
    # 一次心跳最多调用几轮工具，防止一次醒来就停不下来
    max_steps_per_wake: int = 12

    # 心跳间隔（分钟），实际会在区间内随机，避免像闹钟一样机械
    wake_interval_min: tuple[int, int] = (40, 90)
    # 几点“睡觉”（做当天的反思整理），以及夜里不主动打扰别人的时段
    sleep_hour: int = 2
    quiet_hours: tuple[int, int] = (0, 8)

    # 主动找人聊天的上限：每人每天最多几条
    dm_per_person_per_day: int = 3

    # 每次醒来带进上下文的最近事件条数（短期记忆）
    recent_events: int = 40

    extra: dict = field(default_factory=dict)

    @property
    def books_dir(self) -> Path:
        return self.data_dir / "books"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "mind.db"

    @property
    def self_path(self) -> Path:
        return self.data_dir / "self.md"


config = Config()
