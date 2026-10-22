"""思考：把情境交给她的大脑，让她自己决定用哪些工具，直到她说完。

用哪个大脑由 config.brain 决定（见 config.BRAINS）。生活循环只认 think() 这一个接口，
记忆、档案、事件都和大脑无关，换大脑不会失忆。
"""

from .brains import anthropic_api, claude_code, openai_compat
from .config import BRAINS, config
from .energy import Energy  # noqa: F401  （给 life / __main__ 用）
from .tools import Ctx

BACKENDS = {
    "claude_code": claude_code.think,
    "anthropic": anthropic_api.think,
    "openai_compat": openai_compat.think,
}


def think(ctx: Ctx, prompt: str, effort: str, max_steps: int | None = None,
          exclude: tuple[str, ...] = (), web: bool = True) -> str:
    """跑一轮完整的思考，返回她最后说的话。"""
    brain = BRAINS[config.brain]
    return BACKENDS[brain["kind"]](ctx, brain, prompt, effort,
                                   max_steps or config.max_steps_per_wake, exclude, web)
