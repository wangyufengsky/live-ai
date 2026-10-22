"""精力：每天的 token 预算。用完了她就“累了”。"""

from datetime import date

from .config import config
from .store import Store


class Energy:
    def __init__(self, store: Store):
        self.store = store
        if store.get("energy_date") != date.today().isoformat():
            self.reset()

    def reset(self):
        self.store.put("energy_date", date.today().isoformat())
        self.store.put("energy_used", 0)

    @property
    def used(self) -> int:
        return int(self.store.get("energy_used", "0"))

    def spend(self, input_tokens=0, output_tokens=0, cache_creation=0, cache_read=0):
        # 缓存读取很便宜，按十分之一算
        cost = input_tokens + output_tokens + (cache_creation or 0) + (cache_read or 0) // 10
        self.store.put("energy_used", self.used + cost)

    @property
    def percent(self) -> int:
        return max(0, 100 - self.used * 100 // config.daily_energy)
