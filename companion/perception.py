"""感知层：把周围的变化变成她能“注意到”的事件。

每个感受器（sensor）是一个函数 (store) -> list[str]，返回这次新注意到的事，
没有变化就返回空列表。它们会被频繁调用，所以要便宜，并且只在变化时说话。
以后的 QQ 群动态、天气、某人很久没出现……都可以写成新的感受器加进 SENSORS。
"""

from datetime import date

from .config import config
from .store import Store

WEEKDAYS = "一二三四五六日"


def bookshelf(store: Store) -> list[str]:
    known = set(filter(None, (store.get("known_books") or "").split("\n")))
    books = {p.name for p in config.books_dir.iterdir() if p.suffix in (".txt", ".md")}
    if books == known:
        return []
    store.put("known_books", "\n".join(sorted(books)))
    return ([f"书架上多了一本书：{name}" for name in sorted(books - known)]
            + [f"书架上少了一本书：{name}" for name in sorted(known - books)])


def new_day(store: Store) -> list[str]:
    today = date.today()
    last = store.get("last_seen_date")
    if last == today.isoformat():
        return []
    store.put("last_seen_date", today.isoformat())
    return [f"新的一天：{today.month}月{today.day}日，星期{WEEKDAYS[today.weekday()]}"] if last else []


SENSORS = [bookshelf, new_day]


def perceive(store: Store) -> list[str]:
    noticed = [line for sensor in SENSORS for line in sensor(store)]
    for line in noticed:
        store.log("system", line)
    return noticed
