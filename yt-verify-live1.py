"""yt-verify-live1.py -- FIRST LIVE YouTube Shorts publication test on the real phone.

Disposable harness: invokes YouTubeShortPublisher directly with the real
SafeAdb (no backend, no runner). Mirrors runner.py's invocation order:

    ensure_accessibility_healthy (pre-check, runner.py:70 -- REQUIRED at start)
    -> ensure_network_up (connectivity pre-check, new runner gate)
    -> prepare -> push+scan media -> publish(checkpoint) -> verify

YouTube adapter specifics this harness honors (they differ from TikTok):

  * The picker selects media by the EXACT pushed file name: the adapter
    computes remote = "publication-{job.id}-{job.media_id}.{ext}"
    (runner.py:88-91 pushes exactly that in production).  A differently
    named push would fall back to the first grid thumbnail -- an
    unacceptable wrong-video risk on the live channel -- so this harness
    pushes /sdcard/Movies/SouthFarm/publication-999001-999001.mp4 with
    job.id == media_id == 999001 (NOT a free ytverify1- name).
  * Dual dump sources: every screen comes from the accessibility-service
    dump EXCEPT Google's Add details screen (empty service tree), where
    the adapter issues one-off uiautomator dumps via
    SafeAdb.dump_ui_explicit("uiautomator").  The EvidenceDevice
    instruments BOTH sources: raw service XML is read from the on-device
    file, and every parsed uiautomator dump is serialized as evidence
    (ytverify1-explicit-###.xml) -- nothing is ever opened on screen.
  * The single irreversible tap is the "Upload Short" button on the Add
    details screen (uiautomator dump); the harness captures it through
    the final_action checkpoint exactly like TikTok's Post tap.  Upload
    confirmation then waits up to 90s for the "Uploaded to Your Channel"
    marker or a restored main screen without upload UI -- never re-tapped.
  * Verify is the adapter's agile sequence: fixed 20s propagation wait,
    Home -> You -> View channel -> fixed-coordinate Bezier pull-to-refresh
    re-sync, then the composite check (first non-Draft grid tile whose
    desc starts with the caption prefix and carries "No views", absent
    from the pre-publication baseline), 20s -> refresh -> check, 10s ->
    refresh -> check (3 checks max).  On delta, the tile is re-located
    from a fresh dump and the player/description must carry the caption
    prefix.  After 3 checks without confirmation the adapter returns the
    worker-local PublicationStatus.UNVERIFIED (post stays up, never
    republished, last dump attached as evidence); a real YouTube error
    still aborts fail-closed.

Cold-start barrier preserved from the TikTok harness: right after the
monkey launch the first dump(s) can contain only SystemUI while the app
is still rendering; this harness polls (up to COLD_START_TIMEOUT, ~20s)
until a dump contains package com.google.android.youtube before any
tab-bar requirement is evaluated; the adapter keeps its own fail-closed
behavior if the app never renders.

Rules honored: authorized account only (@MarczellWisdom -- any other
identity on the You tab ABORTS, YouTube has no automated switcher by
design), fail-closed (any PublisherError aborts, NO retry, Upload is
never re-tapped), the post is NOT deleted afterwards, evidence (raw
dumps + screenshots) saved in diag/ with the ytverify1- prefix and the
run log diag/ytverify1-live.log.  Every adb invocation travels as
subprocess argv lists (never a shell string), so /sdcard paths cannot be
corrupted by MSYS path conversion.

Caption under both platform limits: "Push yourself because no one else
will do it" (8 words, 43 chars -- the 10-word cap and the 100-character
YouTube Shorts hard limit are enforced by validate_caption inside
publish before any UI interaction).

Screenshots are saved as evidence but this harness NEVER displays them.

Run:  python yt-verify-live1.py    (cwd: worktree root)
Exit codes: 0 = verified, 2 = UNVERIFIED (publication real, verification
pending -- evidence saved as ytverify1-unverified-evidence.json),
1 = aborted.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import time
import traceback
import xml.etree.ElementTree as ET
from pathlib import Path

WORKTREE = Path(__file__).resolve().parent
sys.path.insert(0, str(WORKTREE / "publisher_worker"))

from southfarm_publisher.adb_device import DEFAULT_ADB, SafeAdb  # noqa: E402
from southfarm_publisher.models import PublicationJob, PublicationStatus, PublisherError  # noqa: E402
from southfarm_publisher.platforms.youtube import YouTubeShortPublisher  # noqa: E402

SERIAL = "863d00583048313238510ca492874c"
EXPECTED_ACCOUNT = "MarczellWisdom"
JOB_ID = 999001
LOCAL_VIDEO = r"C:\Users\josu_\Downloads\Videos to test\0730 MA-V-1.mp4"
# Canonical production name (runner.py:88-91): the YouTube picker matches
# media by the exact pushed file name, so the free ytverify1- name would
# make the adapter fall back to the first grid thumbnail.  Never do that.
REMOTE_VIDEO = f"/sdcard/Movies/SouthFarm/publication-{JOB_ID}-{JOB_ID}.mp4"
DIAG = WORKTREE / "diag"
DIAG.mkdir(exist_ok=True)
LOG_PATH = DIAG / "ytverify1-live.log"

# 8 words / 43 chars: within the 10-word cap and the 100-char Shorts limit.
CAPTION = "Push yourself because no one else will do it"

PKG = "com.google.android.youtube"
TABS_BAR_TAB_RID = f"{PKG}:id/tabs_bar_text_tab_view"
UPLOAD_BUTTON_RID = f"{PKG}:id/upload_bottom_button"
CHANNEL_MARKER = "Uploaded to Your Channel"
NO_VIEWS = "No views"
PLAY_SHORT_SUFFIX = " - play Short"
DRAFTS_TILE = "Drafts"
CAPTION_PREFIX_CHARS = 50  # mirror of YouTubeShortPublisher._CAPTION_PREFIX_CHARS
CAPTION_PREFIX = CAPTION[:CAPTION_PREFIX_CHARS]
BOTTOM_TABS = ("Home", "Shorts", "Create", "Subscriptions", "You")
VIEWPORT_X, VIEWPORT_Y = 720, 1640

# Cold-start barrier: after the monkey launch the app tree may not be
# rendered yet, so dumps can arrive SystemUI-only.  Poll for the package
# marker before any tab-bar requirement is evaluated; the adapter still
# fails closed (CREATE_CONTROL/TAB_BAR) if the app never renders.
COLD_START_TIMEOUT = 20.0
COLD_START_POLL = 1.0


def wall() -> str:
    return time.strftime("%H:%M:%S") + f".{int(time.time() * 1000) % 1000:03d}"


def log(message: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {message}"
    print(line, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


def is_short_tile(node) -> bool:
    desc = node.get("content-desc") or ""
    return desc.endswith(PLAY_SHORT_SUFFIX) and desc != DRAFTS_TILE


def channel_tiles(nodes) -> list[dict[str, str]]:
    """Channel Shorts grid tiles in document order (Drafts excluded), mirror
    of YouTubeShortPublisher._grid_tiles."""
    return [node for node in nodes if is_short_tile(node)]


def channel_reached(nodes) -> bool:
    """Mirror of YouTubeShortPublisher._channel_reached for the harness trace."""
    return any(
        node.get("resource-id") == TABS_BAR_TAB_RID
        or (node.get("content-desc") or "") == DRAFTS_TILE
        or is_short_tile(node)
        for node in nodes
    )


def create_present(nodes) -> bool:
    """Mirror of YouTubeShortPublisher._create_control (semantic, package-scoped)."""
    return any(
        node.get("package") == PKG
        and (node.get("content-desc") == "Create" or node.get("text") == "Create")
        for node in nodes
    )


def upload_marker_seen(nodes) -> bool:
    return any(CHANNEL_MARKER in f"{node.get('text', '')} {node.get('content-desc', '')}" for node in nodes)


def upload_percent(nodes) -> str | None:
    return next((node.get("text") for node in nodes if re.fullmatch(r"\d{1,3}%", node.get("text") or "")), None)


def uploading_overlay(nodes) -> str | None:
    return next((node.get("text") for node in nodes if (node.get("text") or "").startswith("Uploading")), None)


def channel_delta(nodes, baseline) -> dict[str, str] | None:
    """Mirror of YouTubeShortPublisher._channel_delta: the first non-Draft grid
    tile whose desc starts with the caption prefix AND carries "No views",
    absent from the pre-publication baseline.  A matching desc that already
    existed in the baseline reads as no-delta (fail-closed)."""
    for tile in channel_tiles(nodes):
        desc = tile.get("content-desc") or ""
        if not desc.startswith(CAPTION_PREFIX) or NO_VIEWS not in desc:
            continue
        if desc in baseline:
            return None
        return tile
    return None


def handle_seen(nodes) -> bool:
    expected = "@" + EXPECTED_ACCOUNT
    return any(node.get("text") == expected or node.get("content-desc") == expected for node in nodes)


class EvidenceDevice:
    """SafeAdb facade that records raw dump XML + screenshots into diag/.

    Instruments taps, swipes, the caption text write and backs so the report
    can state exactly what the adapter did (which swipe mechanism, at which
    moment the Upload tap landed, on which dump / at how many seconds after
    Upload the delta appeared), plus the YouTube-specific traces: upload
    confirmation marker / progress percent / overlay on every publish-phase
    dump and the channel grid tiles + handle on every verify-phase dump.
    Both dump sources are instrumented: the service default (raw XML read
    from the on-device dump file) and the one-off uiautomator dumps the
    adapter issues for Google's protected Add details screen (parsed nodes
    re-serialized as evidence XML, never displayed).  The cold-start
    barrier polls past SystemUI-only service dumps right after the launch.
    """

    def __init__(self, inner: SafeAdb) -> None:
        self._inner = inner
        self.dumps = 0
        self.last_seq = inner._last_dump_seq
        self.phase = "setup"
        self.baseline_tiles: list[str] | None = None
        self.last_tiles: list[str] | None = None
        self.last_channel: bool | None = None
        self.upload_tap: float | None = None
        self.pending_upload = False
        self.upload_marker_logged = False
        self.upload_finished_logged = False
        self.last_upload_percent: str | None = None
        self.taps: list[tuple[float, tuple[int, int, int, int]]] = []
        self.swipes: list[tuple[str, float, tuple[int, ...]]] = []
        self.delta_dump: int | None = None
        self.delta_elapsed: float | None = None
        self.delta_tiles: tuple[list[str], list[str]] | None = None

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def _since_upload(self) -> str:
        if self.upload_tap is None:
            return "pre-Upload"
        return f"{time.monotonic() - self.upload_tap:.1f}s after Upload"

    def _cold_start_barrier(self, nodes):
        """Poll until the YouTube tree renders, BEFORE any tab-bar requirement.

        The monkey launch is asynchronous: the first dump(s) can contain
        only SystemUI while the app is still rendering, and requiring the
        bottom bar on those dumps aborts deterministically.  Re-dump until a
        node carries the app package or the timeout expires; on timeout the
        last dump is returned unchanged and the adapter keeps its own
        fail-closed behavior.  Only the SERVICE dump participates: the
        uiautomator dumps are the Add details screen and are never passed
        through this barrier.
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
        if self.pending_upload:
            self.upload_tap = now
            self.pending_upload = False
            log(f"  UPLOAD TAP at t={now:.3f} wall={wall()} (single irreversible publish tap; no re-tap ever)")
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

    def dump_ui_explicit(self, source: str):
        """Instrumented one-off dump for Google's protected Add details screen.

        The adapter issues uiautomator dumps only there (service tree is
        empty on that screen).  The parsed nodes are re-serialized as
        evidence XML on every call -- the caption echo and the Upload
        Short button are only observable in these dumps.
        """
        nodes = self._inner.dump_ui_explicit(source)
        self.dumps += 1
        log(f"  [explicit dump #{self.dumps} source={source}] {len(nodes)} nodes wall={wall()}")
        root = ET.Element("evidence", {"source": source, "dump": str(self.dumps)})
        for node in nodes:
            ET.SubElement(root, "node", {str(key): str(value) for key, value in node.items()})
        ET.ElementTree(root).write(
            DIAG / f"ytverify1-explicit-{self.dumps:03d}.xml", encoding="utf-8", xml_declaration=True
        )
        return nodes

    def _trace_publish(self, nodes):
        if not self.upload_marker_logged and upload_marker_seen(nodes):
            self.upload_marker_logged = True
            log(f"  UPLOAD CONFIRMED: '{CHANNEL_MARKER}' marker seen wall={wall()} ({self._since_upload()})")
        percent = upload_percent(nodes)
        if percent is not None and percent != self.last_upload_percent:
            self.last_upload_percent = percent
            overlay = uploading_overlay(nodes)
            label = " ".join(part for part in ((overlay or "Uploading..."), percent) if part)
            log(f"  [upload progress] {label} wall={wall()} ({self._since_upload()})")
        if (self.upload_tap is not None and not self.upload_finished_logged
                and create_present(nodes) and upload_percent(nodes) is None and uploading_overlay(nodes) is None):
            self.upload_finished_logged = True
            log(f"  UPLOAD FINISHED (main screen restored, no upload UI) wall={wall()} ({self._since_upload()})")

    def _trace_verify(self, nodes):
        self.last_tiles = [tile.get("content-desc") for tile in channel_tiles(nodes) if tile.get("content-desc")]
        self.last_channel = channel_reached(nodes)
        interesting = [desc for desc in self.last_tiles if desc.startswith(CAPTION_PREFIX) or NO_VIEWS in desc]
        log(f"  [verify dump #{self.dumps}] wall={wall()} {self._since_upload()} tiles={len(self.last_tiles)} "
            f"channel={self.last_channel} handle={handle_seen(nodes)}"
            + (f" interesting={interesting}" if interesting else ""))

    def _check_delta(self, nodes):
        if self.delta_dump is not None or self.baseline_tiles is None:
            return
        # Mirror of YouTubeShortPublisher._channel_delta: the first non-Draft
        # tile whose desc starts with the caption prefix and carries
        # "No views", absent from the pre-publication baseline.
        tile = channel_delta(nodes, self.baseline_tiles)
        if tile is not None:
            self.delta_dump = self.dumps
            self.delta_elapsed = (time.monotonic() - self.upload_tap) if self.upload_tap else None
            self.delta_tiles = (list(self.baseline_tiles), list(self.last_tiles or []))
            log(
                f"  DELTA DETECTED at dump #{self.dumps} wall={wall()}: new grid tile {tile.get('content-desc')!r} "
                f"(prefix + 'No views', absent from baseline)"
                + (f" ({self.delta_elapsed:.1f}s after Upload)" if self.delta_elapsed is not None else "")
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
        # Raw service XML; the Add details screen is Google-protected (empty
        # service tree) and its evidence lives in the ytverify1-explicit-###.xml
        # files written by dump_ui_explicit.  The screenshot is source-blind.
        xml = self._raw_xml()
        if xml.strip():
            (DIAG / f"ytverify1-{name}.xml").write_bytes(xml)
        if screenshot:
            self._inner.screenshot(str(DIAG / f"ytverify1-{name}.png"))
        log(f"  evidence saved: ytverify1-{name}.xml" + (" + .png" if screenshot else ""))


def make_checkpoint(device: EvidenceDevice):
    def checkpoint(step, progress, final_action=False, evidence=None):
        log(f"checkpoint {step} progress={progress} final_action={final_action} evidence={evidence} wall={wall()}")
        if final_action:
            device.pending_upload = True
            device.save_snapshot("upload-screen", screenshot=True)
    return checkpoint


def media_metadata(path: str) -> dict:
    data = Path(path).read_bytes()
    return {
        "id": JOB_ID,
        "size_bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "mime_type": "video/mp4",
        "file_extension": "mp4",
        "duration_seconds": 14,  # 0730 MA-V-1.mp4 is a ~14s clip; the picker
        "width": 1080,           # selects by file NAME on YouTube, so the
        "height": 1920,          # duration only documents the run evidence.
        "video_codec": "hevc",
        "audio_codec": "aac",
    }


def abort_diagnostics(device: EvidenceDevice, code: str) -> None:
    """Read-only screen state at abort: bottom-bar tabs, Create, upload UI,
    channel markers and the account handle, from one fresh service dump."""
    log(f"ABORT DIAGNOSTIC [{code}]: read-only screen state at abort")
    try:
        nodes = device._inner.dump_ui()
    except Exception as error:
        log(f"  fresh dump unavailable at abort: {error}")
        return
    if not nodes:
        log("  service tree EMPTY (Google-protected screen? uiautomator-only evidence is in ytverify1-explicit-###.xml)")
        return
    for node in nodes:
        text, desc = node.get("text"), node.get("content-desc")
        if (text in BOTTOM_TABS or desc in BOTTOM_TABS) and node.get("package") == PKG:
            log(f"  bottom-bar tab: text={text!r} cd={desc!r} bounds={node.get('bounds')!r} clickable={node.get('clickable')!r}")
        if (text == "Create" or desc == "Create") and node.get("package") == PKG:
            log(f"  Create control: text={text!r} cd={desc!r} bounds={node.get('bounds')!r}")
        if node.get("resource-id") == UPLOAD_BUTTON_RID:
            log(f"  Upload Short button: bounds={node.get('bounds')!r}")
    log(f"  markers: handle={handle_seen(nodes)} upload_marker={upload_marker_seen(nodes)} "
        f"percent={upload_percent(nodes)} overlay={uploading_overlay(nodes)!r} tiles={len(channel_tiles(nodes))}")


def main() -> int:
    if LOG_PATH.exists():
        LOG_PATH.unlink()
    log(f"yt-verify-live1 start: serial={SERIAL} account=@{EXPECTED_ACCOUNT} video={LOCAL_VIDEO}")
    log(f"caption: {len(CAPTION.split())} words / {len(CAPTION)} chars (limits: 10 words, 100 chars): {CAPTION!r}")
    if not Path(LOCAL_VIDEO).is_file():
        log("ABORTED: local video file is missing")
        return 1
    device = EvidenceDevice(SafeAdb(SERIAL, ui_source="service"))
    adapter = YouTubeShortPublisher(expected_account=EXPECTED_ACCOUNT)
    job = PublicationJob(
        id=JOB_ID,
        device_id=1,
        media_id=JOB_ID,
        platform="youtube",
        caption=CAPTION,
        media=media_metadata(LOCAL_VIDEO),
        account={"id": 1, "username": EXPECTED_ACCOUNT, "display_name": "Marczell Wisdom", "platform": "youtube"},
        device={"id": 1, "device_id": SERIAL},
    )
    check_index = 0

    def traced_verify_check(job, device):
        nonlocal check_index
        check_index += 1
        upload = device.upload_tap
        elapsed = f"{time.monotonic() - upload:.1f}s after Upload" if upload else "pre-Upload"
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
        tag = "verify-cycle(3s)" if tab_wait == YouTubeShortPublisher._VERIFY_TAB_WAIT else f"pre-identity({tab_wait}s)"
        log(f"RE-SYNC [{tag}]: start wall={wall()} ({device._since_upload()})")
        started = time.monotonic()
        original_resync(device, tab_wait)
        log(f"RE-SYNC [{tag}]: done wall={wall()} in {time.monotonic() - started:.1f}s")

    original_resync = adapter._tab_cycle_resync
    adapter._tab_cycle_resync = traced_resync

    def traced_confirm(job, device):
        log(f"IDENTITY CONFIRM: start wall={wall()} ({device._since_upload()})")
        log(f"  channel state before identity tap (last verify dump): tiles={device.last_tiles} channel={device.last_channel}")
        started = time.monotonic()
        result = original_confirm(job, device)
        log(f"IDENTITY CONFIRM: {'CONFIRMED' if result else 'not confirmed'} wall={wall()} in {time.monotonic() - started:.1f}s -> {result!r}")
        return result

    original_confirm = adapter._confirm_identity
    adapter._confirm_identity = traced_confirm

    def traced_select(device, remote):
        log(f"SELECT THUMBNAIL: start wall={wall()} expected_remote={remote!r} (exact pushed file name)")
        started = time.monotonic()
        result = original_select(device, remote)
        log(f"SELECT THUMBNAIL: done wall={wall()} in {time.monotonic() - started:.1f}s (selected_state badge accepted)")
        return result

    original_select = adapter._select_thumbnail
    adapter._select_thumbnail = traced_select

    def traced_upload_wait(device):
        log(f"UPLOAD CONFIRMATION WAIT: start wall={wall()} (up to {YouTubeShortPublisher._UPLOAD_CONFIRM_TIMEOUT:.0f}s; Upload never re-tapped)")
        started = time.monotonic()
        result = original_upload_wait(device)
        log(f"UPLOAD CONFIRMATION WAIT: confirmed wall={wall()} in {time.monotonic() - started:.1f}s ({device._since_upload()})")
        return result

    original_upload_wait = adapter._wait_upload_confirmation
    adapter._wait_upload_confirmation = traced_upload_wait

    ftt_calls = {"n": 0}

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
        log(f"  [candidate #{index}] rid={node.get('resource-id')!r} text={node.get('text')!r} desc={node.get('content-desc')!r} arrival_bounds={arrival} in_viewport={inside(arrival)} -> re-dumping fresh (up to {re_dumps})")
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

        # 1) prepare: launch -> normalize to main -> You tab -> identity
        #    (@MarczellWisdom, any other identity ABORTS) -> View channel ->
        #    Shorts grid baseline (ordered tile descriptions).  The cold-start
        #    barrier inside dump_ui polls past SystemUI-only dumps right after
        #    the launch before the bottom bar is required.
        device.phase = "prepare"
        adapter.prepare(job, device)
        device.baseline_tiles = list(adapter._baseline_tiles)
        log(f"prepare OK: identity=@{EXPECTED_ACCOUNT} baseline_tiles={len(device.baseline_tiles)} tiles wall={wall()}")
        log(f"  baseline: {device.baseline_tiles}")
        device.save_snapshot("baseline", screenshot=True)

        # 2) transfer media, mirroring runner.run_once.  The name is the
        #    canonical publication-{id}-{media_id}.mp4 so the picker's exact
        #    file-name match (adapter _select_thumbnail) is deterministic.
        device.push(LOCAL_VIDEO, REMOTE_VIDEO)
        device.scan_media(REMOTE_VIDEO)
        log(f"media pushed -> {REMOTE_VIDEO} wall={wall()}")

        # 3) publish: full guarded protocol (100-char caption limit refused
        #    BEFORE any app action).  The single irreversible Upload Short
        #    tap is the last publish tap; upload confirmation then waits up
        #    to 90s for the channel marker or a restored main screen.
        device.phase = "publish"
        adapter.publish(job, device, make_checkpoint(device))
        log(f"publish OK: Upload Short tapped; propagation begins (t_upload={device.upload_tap:.3f} wall={wall()})")

        # 4) verify: 20s -> re-sync (Home->You->View channel + Bezier
        #    refresh) -> check, then 20s -> refresh -> check, then 10s ->
        #    refresh -> check; the delta tile is opened from a fresh dump
        #    for the identity confirmation.
        device.phase = "verify"
        started = time.monotonic()
        identity = adapter.verify(job, device)
        elapsed = time.monotonic() - started
        unverified = identity is None or identity is PublicationStatus.UNVERIFIED
        if identity is PublicationStatus.UNVERIFIED:
            # Worker-local terminal outcome (the YouTube adapter returns the
            # status enum, not None): the publication is real but unproven.
            # This is NOT a success -- the run logs UNVERIFIED, attaches the
            # last-dump evidence and exits 2 (distinct from success 0 and
            # abort 1).
            log(f"verify UNVERIFIED wall={wall()}: adapter returned PublicationStatus.UNVERIFIED after {check_index} checks in {elapsed:.1f}s; post stays up, never republished, phone not touched again")
            device.save_snapshot("unverified", screenshot=True)
            evidence = getattr(adapter, "verification_evidence", None)
            if evidence is not None:
                (DIAG / "ytverify1-unverified-evidence.json").write_text(
                    json.dumps(evidence, indent=2, ensure_ascii=False), encoding="utf-8"
                )
                log("  evidence saved: ytverify1-unverified-evidence.json (last dump attached)")
        elif identity is None:
            log(f"verify UNVERIFIED wall={wall()}: no positive evidence after {check_index} checks in {elapsed:.1f}s; post stays up, never republished, phone not touched again")
            device.save_snapshot("unverified", screenshot=True)
        else:
            log(f"verify OK wall={wall()}: identity={identity!r} verify_elapsed={elapsed:.1f}s (confirmed at check {check_index})")
            device.save_snapshot("verified", screenshot=True)
        if device.delta_dump is not None:
            log(f"DELTA RESULT: dump #{device.delta_dump} of verify, {device.delta_elapsed:.1f}s after Upload, baseline tiles {len(device.delta_tiles[0])} -> visible {len(device.delta_tiles[1])}")
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
