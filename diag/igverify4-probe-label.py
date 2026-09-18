"""Read-only gallery probe: which duration label does Instagram show for MA-V-4?

Non-destructive preparation for ig-verify-live4.  Pushes a probe copy of
0730 MA-V-4.mp4 (16.648s real duration), media-scans it, opens the reel
gallery with the same guarded taps publish() uses, dumps the grid, and
associates each video thumbnail with its duration label.  Then it backs out
to the profile and removes the probe copy.  It NEVER taps Share.

Expected outcome: the newest tile (the just-pushed file) carries either
"0:16" (floor) or "0:17" (round); the harness media_metadata.duration_seconds
is then set to the matching integer so the adapter's duration match succeeds.
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

WORKTREE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKTREE / "publisher_worker"))

from southfarm_publisher.adb_device import DEFAULT_ADB, SafeAdb  # noqa: E402
from southfarm_publisher.platforms import InstagramPublisher  # noqa: E402

SERIAL = "863d00583048313238510ca492874c"
VIDEO = r"C:\Users\josu_\Downloads\Videos to test\0730 MA-V-4.mp4"
REMOTE = "/sdcard/Movies/SouthFarm/igverify4-probe.mp4"
DIAG = WORKTREE / "diag"
DIAG.mkdir(exist_ok=True)


def wall() -> str:
    return time.strftime("%H:%M:%S") + f".{int(time.time() * 1000) % 1000:03d}"


def log(message: str) -> None:
    print(message, flush=True)


def raw_xml(device: SafeAdb, name: str) -> None:
    try:
        result = subprocess.run(
            [DEFAULT_ADB, "-s", SERIAL, "shell", "cat", SafeAdb.SERVICE_DUMP_PATH],
            capture_output=True, timeout=5, check=False,
        )
        if result.returncode == 0 and result.stdout.strip():
            (DIAG / f"igverify4-probe-{name}.xml").write_bytes(result.stdout)
            log(f"  evidence saved: igverify4-probe-{name}.xml")
    except Exception as error:
        log(f"  evidence skipped: {error}")


def main() -> int:
    log(f"probe start {wall()}: serial={SERIAL} video={VIDEO}")
    device = SafeAdb(SERIAL, ui_source="service")
    t0 = time.monotonic()
    if device._service_answers():
        log(f"pre-check OK {wall()}: service answers ({time.monotonic() - t0:.1f}s)")
    else:
        log(f"pre-check {wall()}: service down, repairing once")
        device.ensure_accessibility_healthy()
        log(f"pre-check repaired {wall()}")

    device.push(VIDEO, REMOTE)
    device.scan_media(REMOTE)
    log(f"probe media pushed+scanned {wall()}")

    adapter = InstagramPublisher(expected_account="marzcell.vibes", forbidden_accounts={"santilorennzo"})
    adapter._launch(device)
    nodes = adapter._navigate_profile(device)
    title = adapter.account_control(nodes, resource_id=adapter._TITLE, error="Instagram active profile account")
    log(f"on profile {wall()}: account={title.get('text') or title.get('content-desc')} posts={adapter._post_counts(nodes)}")

    create = adapter._one(nodes, error="CREATE_CONTROL", content_desc="Create New", required=False) \
        or adapter._one(nodes, error="CREATE_CONTROL", text="Create New", required=False)
    if create is None:
        log("ABORT: Create New absent")
        return 1
    reel = adapter.tap_and_wait(device, create, error="REEL_SELECTOR", content_desc="Create new reel")
    adapter.tap_and_wait(device, reel, error="GALLERY_MEDIA", predicate=adapter._gallery_arrival)
    log(f"gallery open {wall()}; dumping grid")
    raw_xml(device, "gallery")

    nodes = adapter._last_nodes
    tiles = [node for node in nodes if adapter._is_video_tile(node)]
    labels = [node.get("text", "") for node in nodes if node.get("resource-id") == adapter._LABEL]
    log(f"gallery: {len(tiles)} video tiles, labels={sorted(set(labels))}")
    for duration in (16, 17):
        matched = adapter._instagram_video_tiles(nodes, duration)
        log(f"duration {duration} -> label 0:{duration:02d}: {len(matched)} matching tile(s)")
        for tile in matched[:3]:
            bounds = SafeAdb.bounds(tile)
            log(f"    tile bounds={bounds} desc={tile.get('content-desc')!r}")
    # Newest-first ordering: the first video tile in document order should be
    # the file pushed seconds ago; report its exact label.
    first = tiles[0] if tiles else None
    if first is not None:
        related = [lab.get("text") for lab in labels_nodes(nodes) if adapter._strictly_overlaps(first, lab)]
        log(f"newest tile: desc={first.get('content-desc')!r} bounds={SafeAdb.bounds(first)} label={related}")
    device.screenshot(str(DIAG / "igverify4-probe-gallery.png"))
    log("  evidence saved: igverify4-probe-gallery.png (not opened by agent)")

    # Back out to the profile, then clean the probe copy.
    for attempt in range(3):
        nodes = adapter._nodes(device)
        if adapter._on_our_profile(nodes):
            break
        device.back()
        time.sleep(1.0)
    nodes = adapter._last_nodes
    log(f"after backs {wall()}: on_profile={adapter._on_our_profile(nodes)}")
    device.remove(REMOTE)
    device.scan_media(REMOTE)
    log(f"probe copy removed+rescanned {wall()}; done")
    return 0


def labels_nodes(nodes):
    return [node for node in nodes if node.get("resource-id") == InstagramPublisher._LABEL]


if __name__ == "__main__":
    raise SystemExit(main())
