"""probe-gallery.py -- NON-destructive gallery-selection probe on the real phone.

Reproduces today's failure (tap on the correct video tile did not register a
selection) in four escalating variants, with raw dump + screenshot evidence
around every attempt. NEVER taps Next/Share/Post/Upload. Ends by backing out
to the profile and deleting the pushed media file.

Run from the worktree root:  python diag/probe-gallery.py
"""

from __future__ import annotations

import re
import subprocess
import sys
import time
import traceback
from pathlib import Path

WORKTREE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKTREE / "publisher_worker"))

from southfarm_publisher.adb_device import DEFAULT_ADB, SafeAdb  # noqa: E402
from southfarm_publisher.models import PublisherError  # noqa: E402
from southfarm_publisher.platforms.instagram import InstagramPublisher  # noqa: E402

SERIAL = "863d00583048313238510ca492874c"
EXPECTED_ACCOUNT = "marczell.vibes"
FORBIDDEN = {"santilorennzo"}
LOCAL_VIDEO = Path(r"C:\Users\josu_\Downloads\Videos to test\MP-V-2.mp4")
REMOTE_VIDEO = "/sdcard/Movies/SouthFarm/probe.mp4"
DIAG = WORKTREE / "diag"
DIAG.mkdir(exist_ok=True)
LOG_PATH = DIAG / "probe.log"

THUMBNAIL = "com.instagram.android:id/gallery_grid_item_thumbnail"
BOTTOM_CONTAINER = "com.instagram.android:id/gallery_grid_item_bottom_container"
LABEL = "com.instagram.android:id/gallery_grid_item_label"
GALLERY_TITLE = "com.instagram.android:id/gallery_title_text"
GALLERY_NEXT = "com.instagram.android:id/next_button_textview"
EDITOR_NEXT = "com.instagram.android:id/clips_right_action_button"
TITLE = "com.instagram.android:id/action_bar_title"

TODAY_RE = re.compile(r"created on August 17, 2026\s+(\d{1,2}):(\d{2})\s+(AM|PM)")
SELECT_POLL_SECONDS = 10.0
SELECT_POLL_STEP = 0.8
SETTLE_SECONDS = 3.0


def log(message: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {message}"
    print(line, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


class ProbeDevice:
    """SafeAdb facade that numbers and saves raw dump XML + screenshots."""

    def __init__(self) -> None:
        self.dev = SafeAdb(SERIAL, ui_source="service")
        self.count = 0
        self.tap_log: list[tuple[str, tuple[int, int], str]] = []

    def __getattr__(self, name):
        return getattr(self.dev, name)

    def raw_xml(self) -> bytes:
        try:
            result = subprocess.run(
                [DEFAULT_ADB, "-s", SERIAL, "shell", "cat", SafeAdb.SERVICE_DUMP_PATH],
                capture_output=True, timeout=5, check=False,
            )
        except Exception:
            return b""
        return result.stdout if result.returncode == 0 else b""

    def snapshot(self, name: str) -> None:
        self.count += 1
        xml = self.raw_xml()
        xml_path = DIAG / f"probe-{self.count:02d}-{name}.xml"
        if xml.strip():
            xml_path.write_bytes(xml)
        self.dev.screenshot(str(DIAG / f"probe-{self.count:02d}-{name}.png"))
        log(f"  evidence {self.count:02d}: probe-{self.count:02d}-{name}.xml/.png")

    def fresh(self) -> list[dict[str, str]]:
        return self.dev.dump_ui()

    def tap_center(self, bounds: tuple[int, int, int, int], tag: str) -> tuple[int, int]:
        center = ((bounds[0] + bounds[2]) // 2, (bounds[1] + bounds[3]) // 2)
        self.dev.tap_bounds(bounds)
        self.tap_log.append((tag, center, f"tap_bounds {bounds}"))
        log(f"  TAP[{tag}] center={center} bounds={bounds}")
        return center

    def tap_raw(self, x: int, y: int, tag: str) -> None:
        self.dev.command("shell", "input", "tap", str(x), str(y))
        self.tap_log.append((tag, (x, y), "input tap direct"))
        log(f"  TAP[{tag}] RAW input tap center=({x},{y})")


def wait_pause(seconds: float) -> None:
    time.sleep(seconds)


def selection_signal(nodes: list[dict[str, str]]) -> dict[str, str] | None:
    for node in nodes:
        if node.get("resource-id") == THUMBNAIL and (node.get("content-desc") or "").startswith("Selected Video thumbnail"):
            return node
    for node in nodes:
        if node.get("resource-id") == EDITOR_NEXT:
            return node
    return None


def editor_visible(nodes: list[dict[str, str]]) -> bool:
    return any(node.get("resource-id") == EDITOR_NEXT for node in nodes)


def next_visible(nodes: list[dict[str, str]]) -> dict[str, str] | None:
    return next((node for node in nodes if node.get("resource-id") == GALLERY_NEXT and node.get("text") == "Next"), None)


def selected_desc(nodes: list[dict[str, str]]) -> str:
    return next((node.get("content-desc", "") for node in nodes
                 if node.get("resource-id") == THUMBNAIL and (node.get("content-desc") or "").startswith("Selected Video thumbnail")), "")


def tile_key(node: dict[str, str]) -> int:
    match = TODAY_RE.search(node.get("content-desc") or "")
    hour = int(match.group(1)) % 12
    if match.group(3) == "PM":
        hour += 12
    return hour * 60 + int(match.group(2))


def find_today_tile(nodes: list[dict[str, str]]) -> dict[str, str] | None:
    candidates = [node for node in nodes
                  if node.get("resource-id") == THUMBNAIL and TODAY_RE.search(node.get("content-desc") or "")]
    if not candidates:
        return None
    return max(candidates, key=tile_key)


def labels_for(nodes: list[dict[str, str]], tile: dict[str, str]) -> list[str]:
    tile_bounds = SafeAdb.bounds(tile)
    texts = []
    for node in nodes:
        if node.get("resource-id") != LABEL:
            continue
        try:
            other = SafeAdb.bounds(node)
        except PublisherError:
            continue
        ax1, ay1, ax2, ay2 = tile_bounds
        bx1, by1, bx2, by2 = other
        if ax1 < bx2 and bx1 < ax2 and ay1 < by2 and by1 < ay2:
            texts.append(node.get("text") or "")
    return texts


def flow_markers(nodes: list[dict[str, str]]) -> list[str]:
    markers = []
    if any(node.get("resource-id") in (GALLERY_TITLE, GALLERY_NEXT, EDITOR_NEXT) for node in nodes):
        markers.append("gallery/editor control")
    if any(node.get("resource-id") == THUMBNAIL for node in nodes):
        markers.append("gallery thumbnails")
    if any(node.get("content-desc") == "Create new reel" or node.get("text") == "Create new reel" for node in nodes):
        markers.append("create sheet")
    return markers


def profile_title(nodes: list[dict[str, str]]) -> dict[str, str] | None:
    matches = [node for node in nodes if node.get("resource-id") == TITLE]
    return matches[0] if len(matches) == 1 else None


def back_to_profile(pdev: ProbeDevice, adapter: InstagramPublisher, max_iters: int = 12) -> list[dict[str, str]]:
    """Controlled BACKs (plus a guarded Profile-tab tap if stuck on Home) until the profile is the only screen."""
    for iteration in range(max_iters):
        nodes = pdev.fresh()
        markers = flow_markers(nodes)
        title = profile_title(nodes)
        on_profile = title is not None and (
            title.get("text") == EXPECTED_ACCOUNT or title.get("content-desc") == EXPECTED_ACCOUNT
        )
        if on_profile and not markers:
            log(f"back_to_profile: arrived at profile after {iteration} iterations")
            return nodes
        if any("santilorennzo" in f"{node.get('text', '')} {node.get('content-desc', '')}".casefold() for node in nodes):
            raise RuntimeError("ABORT: forbidden account santilorennzo visible on screen")
        if not markers and title is None:
            tab = None
            try:
                tab = adapter._profile_tab(nodes)
            except PublisherError:
                tab = None
            if tab is not None:
                log(f"back_to_profile: iteration {iteration}, on Home feed, tapping guarded Profile tab")
                try:
                    adapter._tap(pdev.dev, tab)
                    wait_pause(2.5)
                    continue
                except PublisherError as error:
                    log(f"back_to_profile: Profile tab tap failed ({error.code}), falling back to BACK")
        try:
            pkg = pdev.dev.foreground_package()
        except PublisherError:
            pkg = None
        if pkg is not None and pkg != "com.instagram.android":
            log(f"back_to_profile: iteration {iteration}, app left ({pkg}), relaunching Instagram")
            adapter._launch(pdev.dev)
            wait_pause(3.0)
            continue
        log(f"back_to_profile: iteration {iteration}, on_profile={on_profile}, markers={markers}, pressing BACK")
        pdev.dev.back()
        wait_pause(1.5)
    raise RuntimeError("ABORT: could not back out to the Instagram profile")


def poll_after_tap(pdev: ProbeDevice, variant: str) -> tuple[str, list[dict[str, str]]]:
    """Poll up to SELECT_POLL_SECONDS for a selection/editor signal. Never taps."""
    deadline = time.monotonic() + SELECT_POLL_SECONDS
    while True:
        nodes = pdev.fresh()
        sel = selection_signal(nodes)
        if sel is not None:
            kind = "editor" if sel.get("resource-id") == EDITOR_NEXT else "selected"
            log(f"  poll[{variant}] SIGNAL '{kind}' after {SELECT_POLL_SECONDS - (deadline - time.monotonic()):.1f}s")
            return kind, nodes
        if time.monotonic() >= deadline:
            return "none", nodes
        wait_pause(SELECT_POLL_STEP)


def enter_gallery(pdev: ProbeDevice, adapter: InstagramPublisher) -> list[dict[str, str]]:
    nodes = pdev.fresh()
    create = adapter._one(nodes, error="CREATE_CONTROL", content_desc="Create New", required=False) \
        or adapter._one(nodes, error="CREATE_CONTROL", text="Create New", required=False)
    if create is None:
        raise RuntimeError("ABORT: 'Create New' control is absent from the profile")
    log(f"  Create New bounds={create.get('bounds')}")
    pdev.snapshot("profile-verified")
    reel = adapter.tap_and_wait(pdev.dev, create, error="REEL_SELECTOR", content_desc="Create new reel")
    log(f"  reel selector reached: bounds={reel.get('bounds')}")
    adapter.tap_and_wait(pdev.dev, reel, error="GALLERY_MEDIA", predicate=adapter._gallery_arrival)
    nodes = pdev.fresh()
    if not flow_markers(nodes):
        raise RuntimeError("ABORT: gallery did not arrive")
    log("  gallery arrived")
    return nodes


def run_variant(pdev: ProbeDevice, variant: str, mode: str) -> str:
    """One tap attempt with fresh-node relocation, evidence, and a 10s poll."""
    pdev.snapshot(f"{variant}-before")
    nodes = pdev.fresh()
    tile = find_today_tile(nodes)
    if tile is None:
        log(f"  variant {variant}: NO August 17 tile found in fresh dump -- aborting variant")
        return "aborted"
    bounds = SafeAdb.bounds(tile)
    labels = labels_for(nodes, tile)
    log(f"  variant {variant}: tile desc='{tile.get('content-desc')}' bounds={bounds} labels={labels}")
    if mode == "center":
        pdev.tap_center(bounds, variant)
    elif mode == "bottom":
        bottom = None
        for node in nodes:
            if node.get("resource-id") != BOTTOM_CONTAINER:
                continue
            other = SafeAdb.bounds(node)
            if bounds[0] < other[2] and other[0] < bounds[2] and bounds[1] < other[3] and other[1] < bounds[3]:
                bottom = node
                break
        if bottom is None:
            log(f"  variant {variant}: bottom container not found for the tile -- skipping")
            return "aborted"
        pdev.tap_center(SafeAdb.bounds(bottom), variant)
    elif mode == "raw":
        center = ((bounds[0] + bounds[2]) // 2, (bounds[1] + bounds[3]) // 2)
        pdev.tap_raw(center[0], center[1], variant)
    else:
        raise ValueError(mode)
    result, after_nodes = poll_after_tap(pdev, variant)
    pdev.snapshot(f"{variant}-after")
    log(f"  variant {variant}: RESULT={result} selected='{selected_desc(after_nodes)[:60]}' "
        f"editor={editor_visible(after_nodes)} next={'Yes' if next_visible(after_nodes) else 'No'}")
    return result


def cleanup_and_exit(pdev: ProbeDevice, adapter: InstagramPublisher) -> None:
    log("cleanup: backing out to the profile (BACK only, never Share)")
    try:
        back_to_profile(pdev, adapter, max_iters=12)
        pdev.snapshot("final-profile")
    except Exception as error:
        log(f"cleanup back-out warning: {error}")
        try:
            pdev.snapshot("final-unresolved")
        except Exception:
            pass
    try:
        pdev.dev.remove(REMOTE_VIDEO)
        log(f"cleanup: removed {REMOTE_VIDEO}")
    except Exception as error:
        log(f"cleanup: remote media removal skipped: {error}")
    try:
        listing = pdev.dev.command("shell", "ls", "-la", "/sdcard/Movies/SouthFarm/")
        log(f"cleanup: SouthFarm dir now: {listing.strip()}")
    except Exception:
        pass


def main() -> int:
    if LOG_PATH.exists():
        LOG_PATH.unlink()
    log(f"probe-gallery start: serial={SERIAL} account={EXPECTED_ACCOUNT}")
    if not LOCAL_VIDEO.is_file():
        log("ABORTED: local video file is missing")
        return 1
    pdev = ProbeDevice()
    adapter = InstagramPublisher(expected_account=EXPECTED_ACCOUNT, forbidden_accounts=FORBIDDEN,
                                 timeout=15.0, poll=0.6)
    results: list[str] = []
    try:
        # Wake the screen defensively (harmless if already awake).
        try:
            pdev.dev.command("shell", "input", "keyevent", "224")
            pdev.dev.command("shell", "wm", "dismiss-keyguard")
        except PublisherError:
            pass
        log("phase 0: initial state snapshot (leftover flow expected)")
        pdev.snapshot("initial")

        log("phase 1: back out of any leftover flow to the profile")
        back_to_profile(pdev, adapter)

        log("phase 2: identity check")
        nodes = pdev.fresh()
        title = profile_title(nodes)
        identity = (title.get("text") or title.get("content-desc")) if title else None
        forbidden_visible = any(
            "santilorennzo" in f"{node.get('text', '')} {node.get('content-desc', '')}".casefold() for node in nodes
        )
        if identity != EXPECTED_ACCOUNT or forbidden_visible:
            log(f"ABORTED: profile identity={identity!r} forbidden_visible={forbidden_visible}")
            pdev.snapshot("aborted-identity")
            return 2
        log(f"phase 2 OK: active profile is {identity!r}")

        log("phase 3: push + scan_media + sleep 10s")
        pdev.dev.push(str(LOCAL_VIDEO), REMOTE_VIDEO)
        pdev.dev.scan_media(REMOTE_VIDEO)
        log(f"pushed {LOCAL_VIDEO.name} -> {REMOTE_VIDEO}; sleeping 10s")
        wait_pause(10.0)

        log("phase 4: navigate Create New -> Create new reel -> gallery")
        enter_gallery(pdev, adapter)
        pdev.snapshot("gallery-arrived")
        nodes = pdev.fresh()
        tile = find_today_tile(nodes)
        if tile is None:
            log("ABORT: no August 17 tile in gallery after push+scan")
            pdev.snapshot("aborted-no-tile")
            cleanup_and_exit(pdev, adapter)
            return 3
        log(f"today tile: desc='{tile.get('content-desc')}' bounds={SafeAdb.bounds(tile)} labels={labels_for(nodes, tile)}")

        log("phase 5: selection variants (never Next/Share)")
        for variant, mode in (("a", "center"), ("b", "center"), ("c", "bottom"), ("d", "raw")):
            result = run_variant(pdev, variant, mode)
            results.append(f"{variant}:{result}")
            if result in ("selected", "editor"):
                log(f"variant {variant} registered the selection -- stopping (never advance)")
                break
            if result == "aborted":
                log(f"variant {variant} aborted -- trying next variant")
                continue
            wait_pause(SETTLE_SECONDS)

        log(f"phase 5 done, results: {results}")
    except Exception:
        log("probe exception:")
        log(traceback.format_exc())
        try:
            pdev.snapshot("exception")
        except Exception:
            pass
    finally:
        cleanup_and_exit(pdev, adapter)
    log(f"TAPS issued: {pdev.tap_log}")
    ok = results and results[-1].split(":")[1] in ("selected", "editor")
    log(f"RESULT: {'SUCCESS ' + results[-1] if ok else 'NO variant registered selection'} ({results})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
