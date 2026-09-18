"""tt-verify-identity.py -- VERIFY-ONLY identity confirmation of today's
already-published TikTok post on the real phone.

Disposable harness derived from tt-verify-live3.py but stripped of EVERYTHING
that publishes: there is NO prepare, NO media push/scan, NO publish, NO Post
tap and NO cleanup/delete anywhere in this file.  Its single purpose is to
confirm, post-hoc, the identity of the post that the 2026-08-17 run already
published for real (that run aborted its verify phase on the SystemUI navbar
"Home" collision before identity confirmation).

Flow (exactly the verify phase, nothing else):

    pre-check accessibility + network      (runner.py gates, read-only)
    -> monkey-launch TikTok
    -> navigate to the profile tab and require the @marczell.vibes identity
       label (any other account ABORTS -- no automated switcher by design)
    -> capture the current play-count row and log the delta tolerantly:
       ONLY the presence of the "0" tile at the front of the row matters
       (the recorded pre-publication baseline ['65','152','86','578','646']
       is informational -- today's live lesson: 65 drifted to 71, so exact
       row equality is NEVER a gate here)
    -> locate the "0"-play tile (the newest post) and open it through
       TikTokPublisher._fresh_tap_target (fresh re-dump, in-viewport bounds,
       guarded clickable ancestor -- never the arrival dump's geometry)
    -> require the expected caption in the opened post
       (TikTokPublisher._opened_caption, rid "desc")
    -> log VERIFY_IDENTITY: CONFIRMED / NOT_CONFIRMED.

Fail-closed rules honored:
    - The expected caption defaults to
      ("Your habits shape your future not your dreams") and is overridable
      with --caption "..." (evidence/log prefix: --prefix, default
      "ttidentity-").
    - Only navigation taps (the Profile tab) and the guarded tile-open tap
      exist.  Nothing destructive is ever tapped: no Post, no Share, no
      Delete, no menu.
    - If the opened post does not carry the expected caption the viewer is
      closed with BACK and the attempt is retried at most IDENTITY_ATTEMPTS
      (2) times; afterwards the result is NOT_CONFIRMED.
    - Any PublisherError that is not the caption timeout aborts immediately
      with RESULT: FAILURE -- the post is never touched again.
    - A profile without a "0"-play tile at the front of the row cannot have
      its newest post located: the harness reports NOT_CONFIRMED without
      dispatching a single tile tap.

Evidence: raw dumps + screenshots in diag/ with the ttidentity- prefix and
the run log diag/ttidentity-verify.log.  Screenshots are saved as evidence
but this harness NEVER displays them.  Every adb invocation travels as
subprocess argv lists (never a shell string), so /sdcard paths cannot be
corrupted by MSYS path conversion.

Run:  python tt-verify-identity.py [--caption "..."] [--prefix "ttidentity-"]
      (cwd: worktree root)
Exit codes: 0 = CONFIRMED, 2 = NOT_CONFIRMED (post untouched), 1 = aborted.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
import traceback
from pathlib import Path

WORKTREE = Path(__file__).resolve().parent
sys.path.insert(0, str(WORKTREE / "publisher_worker"))

from southfarm_publisher.adb_device import DEFAULT_ADB, SafeAdb  # noqa: E402
from southfarm_publisher.models import PublisherError  # noqa: E402
from southfarm_publisher.platforms.tiktok import TikTokPublisher  # noqa: E402

SERIAL = "863d00583048313238510ca492874c"
EXPECTED_ACCOUNT = "marczell.vibes"
FORBIDDEN = {"santilorennzo"}

# Default identity of the post published by the 2026-08-17 run (overridable
# with --caption).  The harness only ever CONFIRMS this caption -- it never
# publishes anything.
EXPECTED_CAPTION = "Your habits shape your future not your dreams"

# Pre-publication play-count row recorded by today's run.  For delta LOGGING
# only, never for gating: old counts drift live (65 -> 71 happened today).
# The only live signal is the presence of the "0" tile at the front of the
# current row.
EXPECTED_BASELINE_COUNTS = ["65", "152", "86", "578", "646"]

DIAG = WORKTREE / "diag"
DIAG.mkdir(exist_ok=True)
LOG_PATH = DIAG / "ttidentity-verify.log"

DEFAULT_PREFIX = "ttidentity-"


def parse_args() -> argparse.Namespace:
    """CLI: --caption (expected post caption) and --prefix (evidence prefix)."""
    parser = argparse.ArgumentParser(description="Post-hoc TikTok post identity confirmation (verify only, never publishes)")
    parser.add_argument(
        "--caption",
        default=EXPECTED_CAPTION,
        help=f"caption the already-published post must carry (default: {EXPECTED_CAPTION!r})",
    )
    parser.add_argument(
        "--prefix",
        default=DEFAULT_PREFIX,
        help=f"diag/ evidence + log file prefix (default: {DEFAULT_PREFIX!r})",
    )
    return parser.parse_args()

PKG = "com.zhiliaoapp.musically"
PLAY_COUNT_RID = f"{PKG}:id/tv_play_count"
PROFILE_GRID_RID = f"{PKG}:id/i09"
VIEWPORT_X, VIEWPORT_Y = 720, 1640

# Cold-start barrier: right after the monkey launch the app tree may not be
# rendered yet, so dumps can arrive SystemUI-only.  Poll for the package
# marker before any tab-bar requirement is evaluated; the adapter still
# fails closed (PROFILE_TAB) if the app never renders.
COLD_START_TIMEOUT = 20.0
COLD_START_POLL = 1.0

# Bounded identity attempts: a wrong or caption-less opened viewer is closed
# with BACK; after this many attempts the result is NOT_CONFIRMED.
IDENTITY_ATTEMPTS = 2


def wall() -> str:
    return time.strftime("%H:%M:%S") + f".{int(time.time() * 1000) % 1000:03d}"


def log(message: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {message}"
    print(line, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def visible_play_counts(nodes) -> list[str | None]:
    """Mirror of TikTokPublisher._visible_play_counts for the harness trace."""
    row = []
    for node in nodes:
        if node.get("resource-id") != PLAY_COUNT_RID:
            continue
        try:
            x1, y1, _, _ = SafeAdb.bounds(node)
        except PublisherError:
            continue
        if x1 < VIEWPORT_X and y1 < VIEWPORT_Y:
            row.append(node.get("text"))
    return row


def has_grid(nodes) -> bool:
    return any(node.get("resource-id") == PROFILE_GRID_RID for node in nodes)


class EvidenceDevice:
    """SafeAdb facade that records raw dump XML + screenshots into diag/.

    Instruments taps and backs so the report can state exactly what the
    harness did (never more than profile-navigation taps and the guarded
    tile-open taps).  The cold-start barrier polls past SystemUI-only dumps
    right after the launch (before any tab-bar requirement), so the app
    render race can no longer abort PROFILE_TAB.  Every verify-phase dump is
    traced with its visible play-count row and grid presence.
    """

    def __init__(self, inner: SafeAdb, prefix: str = DEFAULT_PREFIX) -> None:
        self._inner = inner
        self.prefix = prefix
        self.dumps = 0
        self.last_seq = inner._last_dump_seq
        self.taps: list[tuple[float, tuple[int, int, int, int]]] = []
        self.back_count = 0
        self.last_counts: list[str | None] | None = None
        self.last_grid: bool | None = None

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def _cold_start_barrier(self, nodes):
        """Poll until the TikTok tree renders, BEFORE any tab-bar requirement.

        The monkey launch is asynchronous: the first dump(s) can contain
        only SystemUI while the app is still rendering.  Re-dump until a
        node carries the app package or the timeout expires; on timeout the
        last dump is returned unchanged and the adapter keeps its own
        fail-closed behavior.
        """
        deadline = time.monotonic() + COLD_START_TIMEOUT
        while not any(node.get("package") == PKG for node in nodes):
            if time.monotonic() >= deadline:
                log(f"  cold-start: dump #{self.dumps} still lacks {PKG} after {COLD_START_TIMEOUT:.0f}s; "
                    "letting the adapter fail closed")
                break
            log(f"  cold-start: dump #{self.dumps} lacks {PKG} (only system UI rendered); "
                f"waiting for the app tree...")
            time.sleep(COLD_START_POLL)
            nodes = self._inner.dump_ui()
            self.dumps += 1
        return nodes

    def tap_bounds(self, bounds, delay_seconds=0.2):
        now = time.monotonic()
        self.taps.append((now, tuple(bounds)))
        log(f"  [tap #{len(self.taps)}] center=({(bounds[0] + bounds[2]) // 2},{(bounds[1] + bounds[3]) // 2}) wall={wall()}")
        return self._inner.tap_bounds(bounds, delay_seconds)

    def back(self):
        self.back_count += 1
        log(f"  [back keyevent #{self.back_count}] wall={wall()}")
        return self._inner.back()

    def dump_ui(self):
        nodes = self._inner.dump_ui()
        self.dumps += 1
        nodes = self._cold_start_barrier(nodes)
        seq = self._inner._last_dump_seq
        if seq == self.last_seq:
            log(f"  ANOMALY: dump #{self.dumps} accepted a non-incrementing seq={seq} (stale fallback)")
        self.last_seq = seq
        self.last_counts = visible_play_counts(nodes)
        self.last_grid = has_grid(nodes)
        log(f"  [dump #{self.dumps}] counts={self.last_counts} grid={self.last_grid}")
        return nodes

    def _raw_xml(self) -> bytes:
        try:
            result = subprocess.run(
                [DEFAULT_ADB, "-s", SERIAL, "shell", "cat", SafeAdb.SERVICE_DUMP_PATH],
                capture_output=True, timeout=5, check=False,
            )
        except Exception:
            return b""
        return result.stdout if result.returncode == 0 else b""

    def save_snapshot(self, name: str, *, screenshot: bool) -> None:
        xml = self._raw_xml()
        if xml.strip():
            (DIAG / f"{self.prefix}{name}.xml").write_bytes(xml)
        if screenshot:
            self._inner.screenshot(str(DIAG / f"{self.prefix}{name}.png"))
        log(f"  evidence saved: {self.prefix}{name}.xml" + (" + .png" if screenshot else ""))


def reach_profile(adapter: TikTokPublisher, device: EvidenceDevice):
    """Monkey-launch TikTok, navigate to the profile tab and require the
    @marczell.vibes identity label.  Any other identity aborts -- TikTok has
    no automated account switcher by design and this harness never taps one.
    """
    adapter._launch(device)
    nodes = adapter._navigate_profile(device)
    identity = adapter.account_control(nodes, resource_id=TikTokPublisher._IDENTITY, error="TikTok active profile account")
    expected = "@" + EXPECTED_ACCOUNT
    if identity.get("text") != expected and identity.get("content-desc") != expected:
        raise PublisherError("ACCOUNT_MISMATCH", "TikTok active profile account does not match the expected identity account")
    log(f"PROFILE REACHED: identity=@{EXPECTED_ACCOUNT} wall={wall()}")
    return nodes


def log_play_counts(adapter: TikTokPublisher, nodes) -> None:
    """Tolerant delta logging: only the '0' at the front of the row is the
    signal.  The recorded baseline is compared for the log line only -- the
    old counts drift live (65 -> 71 happened today), so exact row equality
    must never gate anything here.
    """
    row = [node.get("text") for node in adapter._visible_play_counts(nodes)]
    log(f"PROFILE play-counts live={row}")
    log(f"PROFILE play-counts recorded-baseline={EXPECTED_BASELINE_COUNTS} (informational only)")
    if row and row[0] == "0":
        tail_match = " ".join(row[1:]) == " ".join(EXPECTED_BASELINE_COUNTS)
        log(f"DELTA LOG: newest '0'-play tile present at the front; tail {row[1:]} "
            f"{'matches' if tail_match else 'differs from'} the recorded baseline "
            f"{EXPECTED_BASELINE_COUNTS} -- informational, live drift is tolerated")
    else:
        log(f"DELTA LOG: no '0' at the front of row {row}; the newest post is not locatable by play count")


def confirm_identity(adapter: TikTokPublisher, device: EvidenceDevice, caption: str) -> str | None:
    """Locate the newest tile (the '0' play-count at the front of the row)
    and require the expected caption in the opened post.

    Up to IDENTITY_ATTEMPTS attempts.  Each attempt re-reaches the profile,
    locates the zero tile and opens it ONLY through _fresh_tap_target (fresh
    re-dump, in-viewport bounds, guarded clickable ancestor).  A viewer that
    never carries the expected caption is closed with BACK before the next
    attempt; a profile without a front "0" tile or a tile that never
    re-localizes dispatches NO tap.  Returns the confirmed identity string
    or None (NOT_CONFIRMED -- never an error, never a destructive fallback).
    """
    for attempt in range(1, IDENTITY_ATTEMPTS + 1):
        nodes = reach_profile(adapter, device)
        counts = adapter._visible_play_counts(nodes)
        row = [node.get("text") for node in counts]
        log(f"IDENTITY ATTEMPT {attempt}/{IDENTITY_ATTEMPTS}: profile play-count row={row} wall={wall()}")
        if not row or row[0] != "0":
            log(f"  attempt {attempt}: no '0'-play tile at the front of the row -> newest post not locatable; no tap dispatched")
            continue
        target = adapter._fresh_tap_target(device, adapter._tile_anchor(nodes, counts[0]))
        if target is None:
            log(f"  attempt {attempt}: fresh tap target unavailable (stale bounds or disappeared); no tap dispatched")
            continue
        adapter._tap(device, target)
        try:
            opened = adapter.wait_for(device, error="REEL_MISMATCH", predicate=lambda screen: adapter._opened_caption(screen, caption))
        except PublisherError as error:
            if error.code != "UI_TIMEOUT":
                raise
            log(f"  attempt {attempt}: the opened post does not carry the expected caption -> BACK")
            adapter._back(device)
            continue
        return opened.get("text") or opened.get("content-desc") or caption
    return None


def abort_diagnostics(device: EvidenceDevice, code: str) -> None:
    """Read-only screen state for the tab/identity abort codes."""
    if code not in {"TAB_BAR", "SELECTOR_COLLISION", "PROFILE_TAB", "ACCOUNT_MISMATCH"}:
        return
    log(f"ABORT DIAGNOSTIC [{code}]: bottom-bar/tab candidates on the screen at abort")
    try:
        nodes = device._inner.dump_ui()
    except Exception as error:
        log(f"  fresh dump unavailable at abort: {error}")
        return
    known_tab_rids = {f"{PKG}:id/o70", f"{PKG}:id/o76"}
    for node in nodes:
        if (node.get("text") in {"Home", "Profile", "Create", "Inbox", "Friends"}
                or node.get("content-desc") in {"Home", "Profile", "Create", "Inbox", "Friends"}
                or node.get("resource-id") in known_tab_rids):
            log(f"  tab candidate: rid={node.get('resource-id')!r} text={node.get('text')!r} "
                f"cd={node.get('content-desc')!r} package={node.get('package')!r} "
                f"bounds={node.get('bounds')!r} clickable={node.get('clickable')!r}")


def main() -> int:
    global LOG_PATH
    args = parse_args()
    caption: str = args.caption
    prefix: str = args.prefix
    LOG_PATH = DIAG / f"{prefix}verify.log"
    if LOG_PATH.exists():
        LOG_PATH.unlink()
    log(f"tt-verify-identity start: serial={SERIAL} account=@{EXPECTED_ACCOUNT}")
    log(f"expected caption ({len(caption.split())} words): {caption!r}")
    log(f"recorded baseline play-counts (logging only): {EXPECTED_BASELINE_COUNTS}")
    device = EvidenceDevice(SafeAdb(SERIAL, ui_source="service"), prefix=prefix)
    adapter = TikTokPublisher(expected_account=EXPECTED_ACCOUNT, forbidden_accounts=FORBIDDEN)
    try:
        # 0) accessibility pre-flight, exactly the runner.py gate (read-only).
        t0 = time.monotonic()
        answered_first = device._service_answers()
        first_probe = time.monotonic() - t0
        if answered_first:
            log(f"PRE-CHECK probe wall={wall()}: accessibility service answered a fresh dump on first try ({first_probe:.1f}s)")
        else:
            log(f"PRE-CHECK probe wall={wall()}: service did NOT answer a fresh dump ({first_probe:.1f}s); ensure_accessibility_healthy will attempt ONE repair")
        t1 = time.monotonic()
        device.ensure_accessibility_healthy()
        ensure_elapsed = time.monotonic() - t1
        if answered_first:
            log(f"PRE-CHECK RESULT: VIVO wall={wall()} (ensure_accessibility_healthy healthy no-op path in {ensure_elapsed:.1f}s)")
        else:
            log(f"PRE-CHECK RESULT: REPARADO wall={wall()} (repair + re-verified in {ensure_elapsed:.1f}s)")
        device.last_seq = device._inner._last_dump_seq

        # 0b) connectivity pre-flight, the runner gate right after the
        #     accessibility pre-check.  A phone without working internet
        #     aborts here with DEVICE_OFFLINE, before any tap.
        t_net = time.monotonic()
        device.ensure_network_up()
        log(f"NETWORK CHECK RESULT: OK wall={wall()} (ping/dumpsys probe in {time.monotonic() - t_net:.1f}s)")

        # 1) reach our own profile (identity gate + tolerant delta logging).
        nodes = reach_profile(adapter, device)
        log_play_counts(adapter, nodes)
        device.save_snapshot("profile", screenshot=True)

        # 2) verify the identity of the already-published post.
        identity = confirm_identity(adapter, device, caption)
        if identity is not None:
            device.save_snapshot("opened", screenshot=True)
            log(f"VERIFY_IDENTITY: CONFIRMED wall={wall()} identity={identity!r}")
            log(f"tap count total: {len(device.taps)}  back count: {device.back_count}")
            log("RESULT: SUCCESS")
            return 0
        device.save_snapshot("not-confirmed", screenshot=True)
        log(f"VERIFY_IDENTITY: NOT_CONFIRMED wall={wall()} "
            "(no '0'-play tile locatable or the opened post never carried the expected caption; "
            "no destructive tap was ever dispatched -- the post is untouched)")
        log(f"tap count total: {len(device.taps)}  back count: {device.back_count}")
        log("RESULT: NOT_CONFIRMED (post untouched)")
        return 2
    except Exception as error:
        log("ABORTED (fail-closed, no retry):")
        log(traceback.format_exc())
        code = getattr(error, "code", None)
        abort_diagnostics(device, code)
        try:
            device.save_snapshot("aborted", screenshot=True)
        except Exception:
            pass
        log("RESULT: FAILURE")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
