"""tt-verify-live4.py -- FOURTH LIVE TikTok publication test on the real phone.

Disposable harness: invokes TikTokPublisher directly with the real SafeAdb
(no backend, no runner). Mirrors runner.py's invocation order:

    ensure_accessibility_healthy (pre-check, runner.py:70 -- REQUIRED at start)
    -> ensure_network_up (connectivity pre-check, new runner gate)
    -> prepare -> push+scan media -> publish(checkpoint) -> verify

Same agile TikTok verify as live1/live2 (same user-defined exact timing as
the Instagram adapter, calibrated on fixtures only): fixed 20s propagation
wait after the "Video posted!" toast -> tab-cycle re-sync (Profile -> 3s ->
Home -> 3s -> Profile) + fixed-coordinate Bezier pull-to-refresh (360,350 ->
360,1000, 400ms) -> composite check (the profile grid must show exactly one
"0" play-count tile prepended to the baseline row); 20s -> refresh -> check;
10s -> refresh -> check. When a check detects the delta, the grid is
recomposed with a full tab cycle at 1s settles BEFORE any identity tap; the
newest tile anchor is then re-located from a fresh dump and opened, and the
viewer must carry the full caption in rid "desc". After 3 checks without
positive evidence the adapter returns UNVERIFIED (worker-local, never
republished); a real TikTok error still aborts.

The post-Post confirmation now waits up to TikTokPublisher's 90s upload
timeout: either the "Video posted!" toast or upload completion (the
"Posting..." overlay gone AND the post screen closed) confirms the Post --
the live2 run lost WiFi mid-upload and aborted POST_UNCONFIRMED at the 15s
wait while the upload overlay still showed "Posting... 0%".  The Post tap
stays single and irreversible.

live2 change preserved (cold-start race): right after the monkey launch the
first dump(s) can contain only SystemUI while the app is still rendering,
which made live runs abort PROFILE_TAB on a dump without the tab bar.  This
harness now polls (up to COLD_START_TIMEOUT, ~20s) until a dump contains
package com.zhiliaoapp.musically BEFORE any tab-bar requirement is ever
evaluated; the adapter keeps its own fail-closed behavior if the app never
renders.  Everything else is unchanged from live2.

live3 change (connectivity pre-flight): right after the accessibility
pre-check the harness calls device.ensure_network_up() -- the same
runner.py gate added for the 2026-08-17 lost-WiFi failure.  The probe is
`adb shell ping -c 2 -W 2 8.8.8.8` with a `dumpsys connectivity` fallback
(VALIDATED active default network counts as up); a device without working
internet aborts here with DEVICE_OFFLINE, before prepare or any media push.

live4 (fifth overall run, re-run of the live3 publication): identical to
live3 except video 0730 MA-V-3.mp4, caption "Growth begins where your
comfort zone ends", and the ttverify4- evidence/log prefix.  The live3 run
aborted AFTER the toast at the verify tab cycle with SELECTOR_COLLISION:
the SystemUI 3-button navbar exposes a content-desc "Home" button that
collided with the app's Home tab.  The worker fix is already shipped --
_home_tab/_profile_tab now match with package=com.zhiliaoapp.musically, so
SystemUI nodes are excluded from the selector entirely (224 unit tests OK).
This run exercises that fix end-to-end.

Rules honored: authorized account only (@marczell.vibes -- any other identity
on the profile ABORTS, TikTok has no automated switcher by design),
fail-closed (any PublisherError aborts, NO retry, Post is never re-tapped),
the post is NOT deleted afterwards, evidence (raw dumps + screenshots) saved
in diag/ with the ttverify4- prefix. Every adb invocation travels as
subprocess argv lists (never a shell string), so /sdcard paths cannot be
corrupted by MSYS path conversion.

Screenshots are saved as evidence but this harness NEVER displays them.

Run:  python tt-verify-live4.py    (cwd: worktree root)
Exit codes: 0 = verified, 2 = UNVERIFIED (publication real, verification
pending -- evidence saved as ttverify4-unverified-evidence.json), 1 = aborted.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import time
import traceback
from pathlib import Path

WORKTREE = Path(__file__).resolve().parent
sys.path.insert(0, str(WORKTREE / "publisher_worker"))

from southfarm_publisher.adb_device import DEFAULT_ADB, SafeAdb  # noqa: E402
from southfarm_publisher.models import PublicationJob, PublicationStatus, PublisherError  # noqa: E402
from southfarm_publisher.platforms.tiktok import TikTokPublisher  # noqa: E402

SERIAL = "863d00583048313238510ca492874c"
EXPECTED_ACCOUNT = "marczell.vibes"
FORBIDDEN = {"santilorennzo"}
LOCAL_VIDEO = r"C:\Users\josu_\Downloads\Videos to test\0730 MA-V-3.mp4"
REMOTE_VIDEO = "/sdcard/Movies/SouthFarm/ttverify-live4.mp4"
DIAG = WORKTREE / "diag"
DIAG.mkdir(exist_ok=True)
LOG_PATH = DIAG / "ttverify4-live.log"

# 7 words, within the 10-word cap.
CAPTION = "Growth begins where your comfort zone ends"

PKG = "com.zhiliaoapp.musically"
PLAY_COUNT_RID = f"{PKG}:id/tv_play_count"
PROFILE_GRID_RID = f"{PKG}:id/i09"
POSTED_TOAST_RID = f"{PKG}:id/zxp"
DURATION_LABEL_RID = f"{PKG}:id/gi4"
THUMBNAIL_RID = f"{PKG}:id/ofk"
VIEWPORT_X, VIEWPORT_Y = 720, 1640

# Cold-start barrier: after the monkey launch the app tree may not be
# rendered yet, so dumps can arrive SystemUI-only.  Poll for the package
# marker before any tab-bar requirement is evaluated; the adapter still
# fails closed (PROFILE_TAB) if the app never renders.
COLD_START_TIMEOUT = 20.0
COLD_START_POLL = 1.0


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


def toast_seen(nodes) -> bool:
    return any(
        node.get("resource-id") == POSTED_TOAST_RID and (node.get("text") or "").startswith("Video posted!")
        for node in nodes
    )


class EvidenceDevice:
    """SafeAdb facade that records raw dump XML + screenshots into diag/.

    Instruments taps, swipes, the caption text write and backs so the report
    can state exactly what the adapter did (which swipe mechanism, at which
    moment the Post tap landed, on which dump / at how many seconds after
    Post the delta appeared), plus the live2 traces: picker duration labels
    and thumbnail bounds on every publish-phase dump (stale/off-viewport
    flagged) and the play-count row + grid presence on every verify-phase
    dump.  The first "Video posted!" toast seen is logged with its offset
    from the Post tap.  The live2 cold-start barrier polls past
    SystemUI-only dumps right after the launch (before any tab-bar
    requirement), so the app render race can no longer abort PROFILE_TAB.
    """

    def __init__(self, inner: SafeAdb) -> None:
        self._inner = inner
        self.dumps = 0
        self.last_seq = inner._last_dump_seq
        self.phase = "setup"
        self.baseline_play_counts: list[str] | None = None
        self.last_counts: list[str | None] | None = None
        self.last_grid: bool | None = None
        self.post_tap: float | None = None
        self.pending_post = False
        self.toast_logged = False
        self.taps: list[tuple[float, tuple[int, int, int, int]]] = []
        self.swipes: list[tuple[str, float, tuple[int, ...]]] = []
        self.delta_dump: int | None = None
        self.delta_elapsed: float | None = None
        self.delta_counts: tuple[list[str], list[str | None]] | None = None

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def _since_post(self) -> str:
        if self.post_tap is None:
            return "pre-Post"
        return f"{time.monotonic() - self.post_tap:.1f}s after Post"

    def _cold_start_barrier(self, nodes):
        """Poll until the TikTok tree renders, BEFORE any tab-bar requirement.

        The monkey launch is asynchronous: the first dump(s) can contain
        only SystemUI while the app is still rendering, and requiring the
        Profile tab bar on those dumps aborts PROFILE_TAB deterministically.
        Re-dump until a node carries the app package or the timeout expires;
        on timeout the last dump is returned unchanged and the adapter keeps
        its own fail-closed behavior.
        """
        deadline = time.monotonic() + COLD_START_TIMEOUT
        while not any(node.get("package") == PKG for node in nodes):
            if time.monotonic() >= deadline:
                log(f"  cold-start: dump #{self.dumps} still lacks {PKG} after {COLD_START_TIMEOUT:.0f}s; "
                    "letting the adapter fail closed")
                break
            log(f"  cold-start: dump #{self.dumps} lacks {PKG} (only system UI rendered); "
                f"waiting for the app tree (elapsed={COLD_START_TIMEOUT - (deadline - time.monotonic()):.1f}s)...")
            time.sleep(COLD_START_POLL)
            nodes = self._inner.dump_ui()
            self.dumps += 1
        return nodes

    def tap_bounds(self, bounds, delay_seconds=0.2):
        now = time.monotonic()
        self.taps.append((now, tuple(bounds)))
        if self.pending_post:
            self.post_tap = now
            self.pending_post = False
            log(f"  POST TAP at t={now:.3f} wall={wall()} (last publish tap; no re-tap ever)")
        log(f"  [tap #{len(self.taps)}] center=({(bounds[0] + bounds[2]) // 2},{(bounds[1] + bounds[3]) // 2}) wall={wall()}")
        return self._inner.tap_bounds(bounds, delay_seconds)

    def swipe_bezier(self, x1, y1, x2, y2, duration_ms=400):
        self.swipes.append(("bezier", time.monotonic(), (x1, y1, x2, y2, duration_ms)))
        self._inner.swipe_bezier(x1, y1, x2, y2, duration_ms)
        mode = "motionevent" if self._inner._motionevent_support else "fallback-straight"
        tag = "verify-refresh" if self.phase == "verify" else "gesture"
        log(f"  [swipe-bezier {mode} {tag}] {x1},{y1} -> {x2},{y2} {duration_ms}ms wall={wall()}")
        return None

    def swipe(self, x1, y1, x2, y2, duration_ms=300):
        self.swipes.append(("straight", time.monotonic(), (x1, y1, x2, y2, duration_ms)))
        tag = "verify-refresh" if self.phase == "verify" else "gesture"
        log(f"  [swipe-straight {tag}] {x1},{y1} -> {x2},{y2} {duration_ms}ms wall={wall()}")
        return self._inner.swipe(x1, y1, x2, y2, duration_ms)

    def text(self, value):
        log(f"  [caption write] {value!r} wall={wall()}")
        return self._inner.text(value)

    def back(self):
        log(f"  [back keyevent] wall={wall()}")
        return self._inner.back()

    def dump_ui(self):
        nodes = self._inner.dump_ui()
        self.dumps += 1
        if self.phase in {"prepare", "publish", "verify"}:
            nodes = self._cold_start_barrier(nodes)
        seq = self._inner._last_dump_seq
        if seq == self.last_seq:
            log(f"  ANOMALY: dump #{self.dumps} accepted a non-incrementing seq={seq} (stale fallback)")
        self.last_seq = seq
        if self.phase == "publish":
            self._trace_publish(nodes)
        if self.phase == "verify":
            self._trace_verify(nodes)
            self._check_delta(nodes)
            if self.dumps % 10 == 0:
                self.save_snapshot(f"verify-{self.dumps:03d}", screenshot=(self.dumps % 20 == 0))
        return nodes

    def _trace_publish(self, nodes):
        if not self.toast_logged and toast_seen(nodes):
            self.toast_logged = True
            log(f"  TOAST 'Video posted!' seen wall={wall()} ({self._since_post()})")
        thumbs = [node for node in nodes if node.get("resource-id") == THUMBNAIL_RID]
        labels = [node.get("text") for node in nodes if node.get("resource-id") == DURATION_LABEL_RID and node.get("text")]
        if not thumbs and not labels:
            return
        entries, off_viewport = [], []
        for thumb in thumbs:
            try:
                bounds = SafeAdb.bounds(thumb)
                inside = bounds[0] >= 0 and bounds[1] >= 0 and bounds[2] <= VIEWPORT_X and bounds[3] <= VIEWPORT_Y
            except PublisherError:
                bounds, inside = None, False
            if not inside:
                off_viewport.append(bounds)
            entries.append(bounds)
        log(f"  [picker dump #{self.dumps}] {len(thumbs)} thumbs bounds={entries}"
            + (f" OFF-VIEWPORT={off_viewport}" if off_viewport else "")
            + (f" duration_labels={labels}" if labels else ""))

    def _trace_verify(self, nodes):
        self.last_counts = visible_play_counts(nodes)
        self.last_grid = has_grid(nodes)
        log(f"  [verify dump #{self.dumps}] wall={wall()} {self._since_post()} counts={self.last_counts} grid={self.last_grid}")

    def _check_delta(self, nodes):
        if self.delta_dump is not None or self.baseline_play_counts is None:
            return
        # Prepend-delta mirror of TikTokPublisher._profile_delta (live4
        # lesson): the exact ["0"] + baseline row never materializes on
        # screen -- the new tile is prepended, the oldest baseline count
        # falls behind the bottom bar and old counts drift, so only the
        # front "0" (with a baseline that did NOT lead with "0") counts.
        baseline = list(self.baseline_play_counts)
        row = visible_play_counts(nodes)
        if row and row[0] == "0" and (not baseline or baseline[0] != "0") and has_grid(nodes):
            self.delta_dump = self.dumps
            self.delta_elapsed = (time.monotonic() - self.post_tap) if self.post_tap else None
            self.delta_counts = (list(self.baseline_play_counts), row)
            log(
                f"  DELTA DETECTED at dump #{self.dumps} wall={wall()}: prepended '0' tile, "
                f"baseline {self.baseline_play_counts} -> visible row {row}"
                + (f" ({self.delta_elapsed:.1f}s after Post)" if self.delta_elapsed is not None else "")
            )
            self.save_snapshot("verify-delta", screenshot=True)

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
            (DIAG / f"ttverify4-{name}.xml").write_bytes(xml)
        if screenshot:
            self._inner.screenshot(str(DIAG / f"ttverify4-{name}.png"))
        log(f"  evidence saved: ttverify4-{name}.xml" + (" + .png" if screenshot else ""))


def make_checkpoint(device: EvidenceDevice):
    def checkpoint(step, progress, final_action=False, evidence=None):
        log(f"checkpoint {step} progress={progress} final_action={final_action} evidence={evidence} wall={wall()}")
        if final_action:
            device.pending_post = True
            device.save_snapshot("post-screen", screenshot=True)
    return checkpoint


def media_metadata(path: str) -> dict:
    data = Path(path).read_bytes()
    return {
        "id": 999004,
        "size_bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "mime_type": "video/mp4",
        "file_extension": "mp4",
        "duration_seconds": 15,  # ~15s clip -> picker label expected "0:15" / "00:15"
        "width": 1080,
        "height": 1920,
        "video_codec": "hevc",
        "audio_codec": "aac",
    }


def abort_diagnostics(device: EvidenceDevice, code: str) -> None:
    """Read-only screen state for the two first-tab-cycle abort codes."""
    if code not in {"TAB_BAR", "SELECTOR_COLLISION"}:
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
                f"cd={node.get('content-desc')!r} bounds={node.get('bounds')!r} clickable={node.get('clickable')!r}")


def main() -> int:
    if LOG_PATH.exists():
        LOG_PATH.unlink()
    log(f"tt-verify-live4 start: serial={SERIAL} account=@{EXPECTED_ACCOUNT} video={LOCAL_VIDEO}")
    log(f"caption ({len(CAPTION.split())} words): {CAPTION!r}")
    if not Path(LOCAL_VIDEO).is_file():
        log("ABORTED: local video file is missing")
        return 1
    device = EvidenceDevice(SafeAdb(SERIAL, ui_source="service"))
    adapter = TikTokPublisher(expected_account=EXPECTED_ACCOUNT, forbidden_accounts=FORBIDDEN)
    job = PublicationJob(
        id=999004,
        device_id=1,
        media_id=999004,
        platform="tiktok",
        caption=CAPTION,
        media=media_metadata(LOCAL_VIDEO),
        account={"id": 1, "username": EXPECTED_ACCOUNT, "display_name": "Marczellvibes", "platform": "tiktok"},
        device={"id": 1, "device_id": SERIAL},
    )
    check_index = 0

    def traced_verify_check(job, device):
        nonlocal check_index
        check_index += 1
        post = device.post_tap
        elapsed = f"{time.monotonic() - post:.1f}s after Post" if post else "pre-Post"
        log(f"VERIFY CHECK {check_index}: start wall={wall()} ({elapsed})")
        started = time.monotonic()
        result = original_verify_check(job, device)
        if result:
            log(f"VERIFY CHECK {check_index}: CONFIRMED wall={wall()} in {time.monotonic() - started:.1f}s -> identity={result!r}")
        else:
            log(f"VERIFY CHECK {check_index}: NOT verified wall={wall()} in {time.monotonic() - started:.1f}s (no delta or no identity)")
        return result

    original_verify_check = adapter._verify_check
    adapter._verify_check = traced_verify_check

    def traced_resync(device, tab_wait):
        tag = "verify-cycle(3s)" if tab_wait == TikTokPublisher._VERIFY_TAB_WAIT else f"pre-identity({tab_wait}s)"
        log(f"TAB-CYCLE [{tag}]: start wall={wall()} ({device._since_post()})")
        started = time.monotonic()
        original_resync(device, tab_wait)
        log(f"TAB-CYCLE [{tag}]: done wall={wall()} in {time.monotonic() - started:.1f}s")

    original_resync = adapter._tab_cycle_resync
    adapter._tab_cycle_resync = traced_resync

    def traced_confirm(job, device):
        log(f"IDENTITY CONFIRM: start wall={wall()} ({device._since_post()})")
        log(f"  grid state before identity tap (last verify dump): counts={device.last_counts} grid={device.last_grid}")
        started = time.monotonic()
        result = original_confirm(job, device)
        log(f"IDENTITY CONFIRM: {'CONFIRMED' if result else 'not confirmed'} wall={wall()} in {time.monotonic() - started:.1f}s -> {result!r}")
        return result

    original_confirm = adapter._confirm_identity
    adapter._confirm_identity = traced_confirm

    ftt_calls = {"n": 0}

    def traced_select(device, duration):
        ftt_calls["n"] = 0
        log(f"SELECT MEDIA: start wall={wall()} duration={duration}s expected_labels={sorted(TikTokPublisher._duration_formats(duration))}")
        started = time.monotonic()
        result = original_select(device, duration)
        log(f"SELECT MEDIA: done wall={wall()} in {time.monotonic() - started:.1f}s")
        return result

    original_select = adapter._select_media
    adapter._select_media = traced_select

    def traced_ftt(device, node, *, re_dumps=2):
        ftt_calls["n"] += 1
        index = ftt_calls["n"]
        try:
            arrival = SafeAdb.bounds(node)
        except PublisherError:
            arrival = None

        def inside(bounds):
            return bounds is not None and bounds[0] >= 0 and bounds[1] >= 0 and bounds[2] <= VIEWPORT_X and bounds[3] <= VIEWPORT_Y

        dumps_before = device.dumps
        log(f"  [candidate #{index}] rid={node.get('resource-id')!r} text={node.get('text')!r} arrival_bounds={arrival} in_viewport={inside(arrival)} -> re-dumping fresh (up to {re_dumps})")
        result = original_ftt(device, node, re_dumps=re_dumps)
        fresh = None
        if result is not None:
            try:
                fresh = SafeAdb.bounds(result)
            except PublisherError:
                pass
        if result is not None:
            log(f"  [candidate #{index}] ACCEPTED after {device.dumps - dumps_before} fresh dump(s): fresh_bounds={fresh} in_viewport={inside(fresh)}")
        else:
            log(f"  [candidate #{index}] DISCARDED after {device.dumps - dumps_before} fresh dump(s): kept off-viewport bounds or disappeared (never tapped)")
        return result

    original_ftt = adapter._fresh_tap_target
    adapter._fresh_tap_target = traced_ftt

    try:
        # 0) accessibility pre-flight, exactly the runner.py:70 gate.
        device.phase = "precheck"
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

        # 0b) connectivity pre-flight, the new runner gate right after the
        #     accessibility pre-check (runner: ensure_network_up).  A phone
        #     without working internet aborts here with DEVICE_OFFLINE,
        #     before prepare or any media push.
        t_net = time.monotonic()
        device.ensure_network_up()
        log(f"NETWORK CHECK RESULT: OK wall={wall()} (ping/dumpsys probe in {time.monotonic() - t_net:.1f}s)")

        # 1) prepare: identity check + baseline play-count row. Any account
        #    other than @marczell.vibes on the profile aborts here.  The
        #    cold-start barrier inside dump_ui polls past SystemUI-only
        #    dumps right after the launch before the tab bar is required.
        device.phase = "prepare"
        adapter.prepare(job, device)
        device.baseline_play_counts = list(adapter._baseline_play_counts)
        log(f"prepare OK: identity=@{EXPECTED_ACCOUNT} baseline_play_counts={device.baseline_play_counts} wall={wall()}")
        device.save_snapshot("baseline", screenshot=True)

        # 2) transfer media, mirroring runner.run_once.
        device.push(LOCAL_VIDEO, REMOTE_VIDEO)
        device.scan_media(REMOTE_VIDEO)
        log(f"media pushed -> {REMOTE_VIDEO} wall={wall()}")

        # 3) publish: full guarded protocol, Post tap is the last publish tap.
        device.phase = "publish"
        adapter.publish(job, device, make_checkpoint(device))
        log(f"publish OK: Post tapped; propagation begins (t_post={device.post_tap:.3f} wall={wall()})")

        # 4) verify: 20s -> tab-cycle(3s)+Bezier refresh -> check,
        #    then 20s -> refresh -> check, then 10s -> refresh -> check;
        #    delta recomposes the grid (tab cycle, 1s) before the identity tap.
        device.phase = "verify"
        started = time.monotonic()
        identity = adapter.verify(job, device)
        elapsed = time.monotonic() - started
        unverified = identity is None or identity is PublicationStatus.UNVERIFIED
        if identity is PublicationStatus.UNVERIFIED:
            # Worker-local terminal outcome (the TikTok adapter returns the
            # status enum, not None): the publication is real but unproven.
            # This is NOT a success -- the run logs UNVERIFIED, attaches the
            # last-dump evidence and exits 2 (distinct from success 0 and
            # abort 1).
            log(f"verify UNVERIFIED wall={wall()}: adapter returned PublicationStatus.UNVERIFIED after {check_index} checks in {elapsed:.1f}s; post stays up, never republished, phone not touched again")
            device.save_snapshot("unverified", screenshot=True)
            evidence = getattr(adapter, "verification_evidence", None)
            if evidence is not None:
                (DIAG / "ttverify4-unverified-evidence.json").write_text(
                    json.dumps(evidence, indent=2, ensure_ascii=False), encoding="utf-8"
                )
                log("  evidence saved: ttverify4-unverified-evidence.json (last dump attached)")
        elif identity is None:
            log(f"verify UNVERIFIED wall={wall()}: no positive evidence after {check_index} checks in {elapsed:.1f}s; post stays up, never republished, phone not touched again")
            device.save_snapshot("unverified", screenshot=True)
        else:
            log(f"verify OK wall={wall()}: identity={identity!r} verify_elapsed={elapsed:.1f}s (confirmed at check {check_index})")
            device.save_snapshot("verified", screenshot=True)
        if device.delta_dump is not None:
            log(f"DELTA RESULT: dump #{device.delta_dump} of verify, {device.delta_elapsed:.1f}s after Post, play-counts {device.delta_counts[0]} -> {device.delta_counts[1]}")
        else:
            log("DELTA RESULT: never observed by the harness")
        log(f"swipe log: {device.swipes}")
        log(f"tap count total: {len(device.taps)}")
        log("RESULT: SUCCESS" if not unverified else "RESULT: UNVERIFIED (verification pending)")
        return 0 if not unverified else 2
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
    finally:
        try:
            device.remove(REMOTE_VIDEO)
            log("cleaned pushed media file from device (post itself is NOT deleted)")
        except Exception as error:
            log(f"remote media cleanup skipped: {error}")


if __name__ == "__main__":
    raise SystemExit(main())
