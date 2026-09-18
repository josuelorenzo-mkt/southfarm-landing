"""igverify3-probe-final.py -- passive read-only UI dump AFTER the ig-verify-live3 run.

No taps, no swipes, no back: only service-dump scans to document the post-run
phone state (post itself is NOT deleted). Evidence only.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

WORKTREE = Path(r"C:\SouthFarm\source\.worktrees\semiorganic-publishing")
sys.path.insert(0, str(WORKTREE / "publisher_worker"))

from southfarm_publisher.adb_device import SafeAdb  # noqa: E402

SERIAL = "863d00583048313238510ca492874c"
KEYS = ("posts", "Discipline", "Consistency", "Reel by", "row ", "Profile", "Home")


def scan(device: SafeAdb, label: str) -> None:
    nodes = device.dump_ui()
    print(f"--- {label} wall={time.strftime('%H:%M:%S')} ({len(nodes)} nodes) ---")
    values = sorted({node.get("content-desc", "") or node.get("text", "") for node in nodes if node.get("content-desc") or node.get("text")})
    for value in values:
        if any(key in value for key in KEYS):
            print(repr(value))
    print()


def main() -> None:
    device = SafeAdb(SERIAL, ui_source="service")
    scan(device, "post-run current screen")


if __name__ == "__main__":
    main()
