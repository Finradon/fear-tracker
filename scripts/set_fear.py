#!/usr/bin/env python3
"""Write the Fear state file, for testing the overlays without GNOME.

  set_fear.py 5                      set Fear to 5
  set_fear.py +2 / -1                change relative to the current value
  set_fear.py 3 --max 8              also change the maximum
  set_fear.py --add-countdown NAME START [--progress]
  set_fear.py --tick N [--by D]      change countdown N (1-3) by D (default -1)
  set_fear.py --remove-countdown N   delete countdown N
  set_fear.py --clear-countdowns     delete all countdowns
  set_fear.py --demo                 random walk every 1.5 s (Ctrl+C to stop)
  set_fear.py --init                 create the file with Fear 0 if it doesn't exist
  set_fear.py                        print the current state
"""

import argparse
import random
import secrets
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

from fearstate import (  # noqa: E402
    COUNTDOWN_LIMIT, DEFAULT_MAX, MAX_COUNTDOWNS, clamp, default_state, default_state_dir,
    pip_text, read_state, write_state,
)


def show(state: dict) -> None:
    print(f"Fear {state['fear']}/{state['max']}  {pip_text(state['fear'], state['max'])}")
    for i, c in enumerate(state["countdowns"], 1):
        print(f"  {i}. {c['name'] or 'Countdown'}: {c['value']}/{c['start']} ({c['kind']})")


def new_countdown(name: str, start: int, progress: bool) -> dict:
    start = clamp(start, 1, COUNTDOWN_LIMIT)
    return {"id": secrets.token_hex(4), "name": name, "start": start, "value": start,
            "kind": "progress" if progress else "consequence"}


DEMO_NAMES = ["Ritual completes", "Guards arrive", "The way out", "Bridge collapses"]


def demo(state_dir: Path, max_: int, interval: float) -> None:
    state = read_state(state_dir) or default_state()
    fear, countdowns = state["fear"], state["countdowns"]
    print("Demo mode, Ctrl+C to stop")
    while True:
        fear += random.choice((-2, -1, 1, 1, 2, 3)) if fear < max_ else -random.randint(2, 6)
        # Remove triggered countdowns after a while, tick or add the others.
        countdowns = [c for c in countdowns if c["value"] > 0 or random.random() < 0.6]
        if len(countdowns) < MAX_COUNTDOWNS and random.random() < 0.3:
            countdowns.append(new_countdown(random.choice(DEMO_NAMES), random.randint(3, 8),
                                            random.random() < 0.4))
        elif countdowns:
            c = random.choice(countdowns)
            c["value"] = clamp(c["value"] - 1, 0, c["start"])
        state = write_state(state_dir, fear, max_, countdowns)
        fear, countdowns = state["fear"], state["countdowns"]
        show(state)
        time.sleep(interval)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        epilog="\n".join(__doc__.splitlines()[1:]),
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("value", nargs="?",
                        help="new Fear value, or +N / -N relative to the current one")
    parser.add_argument("--max", type=int, help="set the maximum Fear (1-30)")
    group = parser.add_argument_group("countdowns")
    group.add_argument("--add-countdown", nargs=2, metavar=("NAME", "START"),
                       help=f"add a countdown (at most {MAX_COUNTDOWNS})")
    group.add_argument("--progress", action="store_true",
                       help="with --add-countdown: a progress countdown (default: consequence)")
    group.add_argument("--tick", type=int, metavar="N", help="change countdown N (1-based)")
    group.add_argument("--by", type=int, default=-1, help="with --tick: amount (default -1)")
    group.add_argument("--remove-countdown", type=int, metavar="N", help="delete countdown N")
    group.add_argument("--clear-countdowns", action="store_true", help="delete all countdowns")
    parser.add_argument("--demo", action="store_true", help="random walk to exercise the overlays")
    parser.add_argument("--interval", type=float, default=1.5, help="demo step in seconds")
    parser.add_argument("--init", action="store_true",
                        help="create the state file if missing, otherwise leave it alone")
    parser.add_argument("--state-dir", type=Path, default=default_state_dir())
    args = parser.parse_args()

    state_dir = args.state_dir.expanduser()
    current = read_state(state_dir)

    if args.init:
        if current is None:
            current = write_state(state_dir, 0, args.max or DEFAULT_MAX)
            print(f"Created {state_dir / 'fear.json'}")
        show(current)
        return

    current = current or default_state()
    max_ = args.max if args.max is not None else current["max"]

    if args.demo:
        try:
            demo(state_dir, max_, args.interval)
        except KeyboardInterrupt:
            print()
        return

    fear = current["fear"]
    countdowns = current["countdowns"]
    changed = args.max is not None

    if args.value is not None:
        try:
            n = int(args.value)
        except ValueError:
            parser.error(f"not a number: {args.value!r}")
        fear = fear + n if args.value[0] in "+-" else n
        changed = True

    def index(n: int) -> int:
        if not 1 <= n <= len(countdowns):
            parser.error(f"no countdown {n} (there are {len(countdowns)})")
        return n - 1

    if args.add_countdown:
        name, start = args.add_countdown
        if len(countdowns) >= MAX_COUNTDOWNS:
            parser.error(f"already {MAX_COUNTDOWNS} countdowns; remove one first")
        try:
            countdowns.append(new_countdown(name, int(start), args.progress))
        except ValueError:
            parser.error(f"not a number: {start!r}")
        changed = True
    if args.tick is not None:
        c = countdowns[index(args.tick)]
        c["value"] = clamp(c["value"] + args.by, 0, c["start"])
        changed = True
    if args.remove_countdown is not None:
        del countdowns[index(args.remove_countdown)]
        changed = True
    if args.clear_countdowns:
        countdowns = []
        changed = True

    show(write_state(state_dir, fear, max_, countdowns) if changed else current)


if __name__ == "__main__":
    main()
