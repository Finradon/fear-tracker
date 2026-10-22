#!/usr/bin/env python3
"""Write the Fear state file, for testing the overlay without GNOME.

  set_fear.py 5            set Fear to 5
  set_fear.py +2 / -1      change relative to the current value
  set_fear.py 3 --max 8    also change the maximum
  set_fear.py --demo       random walk every 1.5 s (Ctrl+C to stop)
  set_fear.py --init       create the file with Fear 0 if it doesn't exist
  set_fear.py              print the current state
"""

import argparse
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

from fearstate import (  # noqa: E402
    DEFAULT_MAX, default_state, default_state_dir, pip_text, read_state, write_state,
)


def show(state: dict) -> None:
    print(f"Fear {state['fear']}/{state['max']}  {pip_text(state['fear'], state['max'])}")


def demo(state_dir: Path, max_: int, interval: float) -> None:
    fear = (read_state(state_dir) or default_state())["fear"]
    print("Demo mode, Ctrl+C to stop")
    while True:
        fear += random.choice((-2, -1, 1, 1, 2, 3)) if fear < max_ else -random.randint(2, 6)
        show(write_state(state_dir, fear, max_))
        time.sleep(interval)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        epilog="\n".join(__doc__.splitlines()[1:]),
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("value", nargs="?",
                        help="new Fear value, or +N / -N relative to the current one")
    parser.add_argument("--max", type=int, help="set the maximum Fear (1-30)")
    parser.add_argument("--demo", action="store_true", help="random walk to exercise the overlay")
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

    if args.value is None and args.max is None:
        show(current)
        return

    fear = current["fear"]
    if args.value is not None:
        try:
            n = int(args.value)
        except ValueError:
            parser.error(f"not a number: {args.value!r}")
        fear = fear + n if args.value[0] in "+-" else n

    show(write_state(state_dir, fear, max_))


if __name__ == "__main__":
    main()
