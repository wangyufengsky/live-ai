"""命令行入口。

    python -m companion run                  # 让她开始持续生活（心跳 + 每晚睡觉）
    python -m companion wake                 # 手动叫醒她一次
    python -m companion sleep                # 手动让她睡一觉（反思整理）
    python -m companion chat --id me --name 小王   # 以某个身份和她私聊
    python -m companion status               # 看看她现在的状态

加 --brain 临时换大脑（名字见 config.BRAINS），比如 --brain claude_code。
"""

import argparse
import time

from .life import chat, is_alive, run_forever, sleep, wake
from .config import BRAINS, config
from .mind import Energy
from .store import Store, fmt_ts


def _show_outbox(store: Store, person_id: str) -> bool:
    """把她发给这个人的消息打印出来。收到了回复就返回 True。"""
    got_reply = False
    for m in store.take_outbox(person_id):
        if m["kind"] == "reply":
            print(f"她：{m['content']}")
            got_reply = True
        else:
            print(f"（{fmt_ts(m['ts'])} 她主动找你）她：{m['content']}")
    return got_reply


def _send_via_life(store: Store, person_id: str, name: str, text: str):
    """她正在 run 里生活：消息放进收件箱，等她忙完手上的事再回。"""
    store.push_inbox(f"dm:{person_id}", person_id, name, text)
    print("（已发出，她看到会回）")
    deadline = time.time() + 600
    while time.time() < deadline:
        if _show_outbox(store, person_id):
            return
        time.sleep(1)
    print("（她暂时没回，可能在忙。回复会在下次打开聊天时显示）")


def cmd_chat(store: Store, person_id: str, name: str):
    store.see_person(person_id, name)
    _show_outbox(store, person_id)
    print(f"以 {name} 的身份聊天。/dm on|off 设置是否允许她主动找你，/bye 退出。")
    while True:
        try:
            text = input(f"{name}：").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not text:
            continue
        if text == "/bye":
            break
        if text in ("/dm on", "/dm off"):
            ok = text.endswith("on")
            store.set_dm_ok(person_id, ok)
            store.log("system", f"{name} {'允许' if ok else '不再允许'}我主动私聊 ta", f"dm:{person_id}")
            print("（已设置）")
            continue
        if is_alive(store):
            _send_via_life(store, person_id, name, text)
        else:
            print(f"她：{chat(store, person_id, name, text) or '……'}")


def cmd_status(store: Store):
    print(f"大脑：{config.brain}（{BRAINS[config.brain]['model']}）")
    print(f"精力：{Energy(store).percent}%")
    print(f"记忆：{store.db.execute('SELECT COUNT(*) FROM memories WHERE faded = 0').fetchone()[0]} 条")
    print("线头：")
    for t in store.threads(("active", "resting")):
        print(f"  #{t['id']} [{t['status']}] {t['title']} —— {t['note']}")
    print("认识的人：")
    for p in store.people():
        print(f"  {p['name']}（{p['id']}）：{p['notes']}")
    print("\n" + store.read_self())


def main():
    parser = argparse.ArgumentParser(prog="companion")
    parser.add_argument("--brain", choices=sorted(BRAINS), help="这次用哪个大脑")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run")
    sub.add_parser("wake")
    sub.add_parser("sleep")
    sub.add_parser("status")
    p_chat = sub.add_parser("chat")
    p_chat.add_argument("--id", required=True)
    p_chat.add_argument("--name", required=True)
    args = parser.parse_args()
    if args.brain:
        config.brain = args.brain

    store = Store()
    if args.cmd == "run":
        run_forever(store)
    elif args.cmd == "wake":
        print(wake(store) or "（她什么也没说）")
    elif args.cmd == "sleep":
        print(sleep(store) or "（她什么也没说）")
    elif args.cmd == "chat":
        cmd_chat(store, args.id, args.name)
    elif args.cmd == "status":
        cmd_status(store)


if __name__ == "__main__":
    main()
