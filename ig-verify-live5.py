"""ig-verify-live5.py -- fifth LIVE Instagram publication test on the real phone.

Disposable harness: invokes InstagramPublisher directly with the real SafeAdb
(no backend, no runner). Mirrors runner.py's invocation order:

    ensure_accessibility_healthy (pre-check, runner.py:70 -- REQUIRED at start)
    -> prepare -> push+scan media -> publish(checkpoint) -> verify

This run is the re-test of the aborted live4 run: SAME media (MA-V-4) and
SAME caption ("Fall in love with the process and trust it", 9 words -- it was
never used because live4 aborted before the caption step).

It exercises the NEW fix in the worker that live4 aborted on: _select_video
now re-dumps fresh before EVERY candidate tap (_fresh_tap_target) and demands
bounds fully inside the 720x1640 viewport; a stale/off-viewport candidate is
discarded, never tapped. This harness traces each candidate attempt: arrival
bounds, every fresh re-dump, accepted fresh bounds or discard.

It also exercises the agile post-Share verify already in the worker: fixed
20s propagation wait -> tab-cycle re-sync (Profile -> 3s -> Home -> 3s ->
Profile) + fixed-coordinate Bezier pull-to-refresh -> composite delta+identity
check; 20s -> refresh -> check; 10s -> refresh -> check; when a check detects
delta, the grid is recomposed with a full tab cycle at 1s settles BEFORE the
identity tap; after 3 checks without positive evidence the adapter returns
None (worker-local `unverified`, never republished). The harness reports
which check saw the delta, at how many seconds post-Share, the signal used
(post count / new tiles), the grid state right before the identity tap, and
the caption confirmation.

Rules honored: authorized account only (marczell.vibes, santilorennzo
forbidden), fail-closed (any PublisherError aborts, NO retry), the post is NOT
deleted afterwards, evidence (raw dumps + screenshots) saved in diag/ with the
igverify5- prefix. Every adb invocation in this harness travels as subprocess
argv lists (never a shell string), so /sdcard paths cannot be corrupted by
MSYS path conversion.

Run:  python ig-verify-live5.py    (cwd: worktree root)
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import time
import traceback
from pathlib import Path

WORKTREE = Path(__file__).resolve().parent
sys.path.insert(0, str(WORKTREE / "publisher_worker"))

from southfarm_publisher.adb_device import DEFAULT_ADB, SafeAdb  # noqa: E402
from southfarm_publisher.models import PublicationJob, PublisherError  # noqa: E402
from southfarm_publisher.platforms import InstagramPublisher  # noqa: E402

SERIAL = "863d00583048313238510ca492874c"
EXPECTED_ACCOUNT = "marczell.vibes"
FORBIDDEN = {"santilorennzo"}
LOCAL_VIDEO = r"C:\Users\josu_\Downloads\Videos to test\0730 MA-V-4.mp4"
REMOTE_VIDEO = "/sdcard/Movies/SouthFarm/igverify-live5.mp4"
DIAG = WORKTREE / "diag"
DIAG.mkdir(exist_ok=True)
LOG_PATH = DIAG / "igverify5-live.log"

# SAME caption as the aborted live4 run: 9 words, within the 10-word cap,
# unused until now because live4 never reached the caption step.
CAPTION = "Fall in love with the process and trust it"

POST_COUNT_RID = "com.instagram.android:id/profile_header_post_count_front_familiar"
THUMBNAIL_RID = "com.instagram.android:id/gallery_grid_item_thumbnail"
GRID_TILE = re.compile(r"Reel by .+ at row \d+, column \d+")
POSTS = re.compile(r"(\d+)posts")


def wall() -> str:
    return time.strftime("%H:%M:%S") + f".{int(time.time() * 1000) % 1000:03d}"


def log(message: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {message}"
    print(line, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


class EvidenceDevice:
    """SafeAdb facade that records raw dump XML + screenshots into diag/.

    Also instruments taps and swipes so the report can state exactly what the
    adapter did (which swipe mechanism, at which moment the Share tap landed,
    and on which dump / at how many seconds after Share the delta appeared),
    plus the NEW live5 traces: gallery-thumbnail bounds on every publish-phase
    dump (stale/off-viewport flagged) and post-count + tile counts on every
    verify-phase dump.
    """

    def __init__(self, inner: SafeAdb) -> None:
        self._inner = inner
        self.dumps = 0
        self.last_seq = inner._last_dump_seq
        self.phase = "setup"
        self.baseline_posts: int | None = None
        self.baseline_tiles: frozenset[str] = frozenset()
        self.last_tiles: frozenset[str] | None = None
        self.share_tap: float | None = None
        self.pending_share = False
        self.taps: list[tuple[float, tuple[int, int, int, int]]] = []
        self.swipes: list[tuple[str, float, tuple[int, ...]]] = []
        self.delta_dump: int | None = None
        self.delta_elapsed: float | None = None
        self.delta_counts: tuple[int, int] | None = None

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def _since_share(self) -> str:
        if self.share_tap is None:
            return "pre-Share"
        return f"{time.monotonic() - self.share_tap:.1f}s after Share"

    def tap_bounds(self, bounds, delay_seconds=0.2):
        now = time.monotonic()
        self.taps.append((now, tuple(bounds)))
        if self.pending_share:
            self.share_tap = now
            self.pending_share = False
            log(f"  SHARE TAP at t={now:.3f} wall={wall()}")
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

    def dump_ui(self):
        nodes = self._inner.dump_ui()
        self.dumps += 1
        seq = self._inner._last_dump_seq
        if seq == self.last_seq:
            log(f"  ANOMALY: dump #{self.dumps} accepted a non-incrementing seq={seq} (stale fallback)")
        self.last_seq = seq
        if self.phase == "publish":
            self._trace_gallery(nodes)
        if self.phase == "verify":
            self._trace_verify(nodes)
            self._check_delta(nodes)
            if self.dumps % 10 == 0:
                self.save_snapshot(f"verify-{self.dumps:03d}", screenshot=(self.dumps % 20 == 0))
        return nodes

    def _trace_gallery(self, nodes):
        thumbs = [node for node in nodes if node.get("resource-id") == THUMBNAIL_RID]
        if not thumbs:
            return
        entries, off_viewport = [], []
        for thumb in thumbs:
            try:
                bounds = SafeAdb.bounds(thumb)
                inside = bounds[0] >= 0 and bounds[1] >= 0 and bounds[2] <= 720 and bounds[3] <= 1640
            except PublisherError:
                bounds, inside = None, False
            if not inside:
                off_viewport.append(bounds)
            entries.append(bounds)
        log(f"  [gallery dump #{self.dumps}] {len(thumbs)} thumbs bounds={entries}"
            + (f" OFF-VIEWPORT={off_viewport}" if off_viewport else ""))

    def _trace_verify(self, nodes):
        posts = sorted({
            int(match.group(1))
            for node in nodes
            if node.get("resource-id") == POST_COUNT_RID
            for match in [POSTS.fullmatch((node.get("content-desc") or "").strip())]
            if match
        })
        tiles = frozenset(node.get("content-desc", "") for node in nodes if GRID_TILE.fullmatch(node.get("content-desc") or ""))
        self.last_tiles = tiles
        log(f"  [verify dump #{self.dumps}] wall={wall()} {self._since_share()} posts={posts} tiles={len(tiles)}")

    def _check_delta(self, nodes):
        if self.delta_dump is not None or self.baseline_posts is None:
            return
        count_ok = any(
            n.get("resource-id") == POST_COUNT_RID and (n.get("content-desc") or "").strip() == f"{self.baseline_posts + 1}posts"
            for n in nodes
        )
        tiles = frozenset(n.get("content-desc", "") for n in nodes if GRID_TILE.fullmatch(n.get("content-desc") or ""))
        if count_ok or bool(tiles - self.baseline_tiles):
            self.delta_dump = self.dumps
            self.delta_elapsed = (time.monotonic() - self.share_tap) if self.share_tap else None
            self.delta_counts = (len(self.baseline_tiles), len(tiles))
            log(
                f"  DELTA DETECTED at dump #{self.dumps} wall={wall()}: new_tiles={sorted(tiles - self.baseline_tiles)} "
                f"count_ok={count_ok} tiles {len(self.baseline_tiles)}->{len(tiles)}"
                + (f" ({self.delta_elapsed:.1f}s after Share)" if self.delta_elapsed is not None else "")
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
            (DIAG / f"igverify5-{name}.xml").write_bytes(xml)
        if screenshot:
            self._inner.screenshot(str(DIAG / f"igverify5-{name}.png"))
        log(f"  evidence saved: igverify5-{name}.xml" + (" + .png" if screenshot else ""))


def make_checkpoint(device: EvidenceDevice):
    def checkpoint(step, progress, final_action=False, evidence=None):
        log(f"checkpoint {step} progress={progress} final_action={final_action} evidence={evidence} wall={wall()}")
        if final_action:
            device.pending_share = True
            device.save_snapshot("share-screen", screenshot=True)
    return checkpoint


def media_metadata(path: str) -> dict:
    data = Path(path).read_bytes()
    return {
        "id": 999003,
        "size_bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "mime_type": "video/mp4",
        "file_extension": "mp4",
        "duration_seconds": 17,  # ffprobe: 16.648s -> gallery label "0:17" (probe-proven in live4)
        "width": 1080,
        "height": 1920,
        "video_codec": "hevc",
        "audio_codec": "aac",
    }


def main() -> int:
    if LOG_PATH.exists():
        LOG_PATH.unlink()
    log(f"ig-verify-live5 start: serial={SERIAL} account={EXPECTED_ACCOUNT} video={LOCAL_VIDEO}")
    log(f"caption ({len(CAPTION.split())} words): {CAPTION!r}")
    if not Path(LOCAL_VIDEO).is_file():
        log("ABORTED: local video file is missing")
        return 1
    device = EvidenceDevice(SafeAdb(SERIAL, ui_source="service"))
    adapter = InstagramPublisher(expected_account=EXPECTED_ACCOUNT, forbidden_accounts=FORBIDDEN)
    job = PublicationJob(
        id=999003,
        device_id=1,
        media_id=999003,
        platform="instagram",
        caption=CAPTION,
        media=media_metadata(LOCAL_VIDEO),
        account={"id": 1, "username": EXPECTED_ACCOUNT, "display_name": "Marczellvibes", "platform": "instagram"},
        device={"id": 1, "device_id": SERIAL},
    )
    check_index = 0

    def traced_verify_check(job, device):
        nonlocal check_index
        check_index += 1
        share = device.share_tap
        elapsed = f"{time.monotonic() - share:.1f}s after Share" if share else "pre-Share"
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
        tag = "verify-cycle(3s)" if tab_wait == InstagramPublisher._VERIFY_TAB_WAIT else f"pre-identity({tab_wait}s)"
        log(f"TAB-CYCLE [{tag}]: start wall={wall()} ({device._since_share()})")
        started = time.monotonic()
        original_resync(device, tab_wait)
        log(f"TAB-CYCLE [{tag}]: done wall={wall()} in {time.monotonic() - started:.1f}s")

    original_resync = adapter._tab_cycle_resync
    adapter._tab_cycle_resync = traced_resync

    def traced_confirm(job, device):
        log(f"IDENTITY CONFIRM: start wall={wall()} ({device._since_share()})")
        last = device.last_tiles
        if last is not None:
            new = sorted(tile for tile in last if tile not in device.baseline_tiles)
            log(f"  grid before identity tap (last verify dump): tiles={sorted(last)} new={new}")
        started = time.monotonic()
        result = original_confirm(job, device)
        log(f"IDENTITY CONFIRM: {'CONFIRMED' if result else 'not confirmed'} wall={wall()} in {time.monotonic() - started:.1f}s -> {result!r}")
        return result

    original_confirm = adapter._confirm_identity
    adapter._confirm_identity = traced_confirm

    ftt_calls = {"n": 0}

    def traced_select(device, duration):
        ftt_calls["n"] = 0
        log(f"SELECT VIDEO: start wall={wall()} duration={duration}s expected_label={next(iter(InstagramPublisher._duration_formats(duration)))}")
        started = time.monotonic()
        result = original_select(device, duration)
        log(f"SELECT VIDEO: done wall={wall()} in {time.monotonic() - started:.1f}s")
        return result

    original_select = adapter._select_video
    adapter._select_video = traced_select

    def traced_ftt(device, node, *, re_dumps=2):
        ftt_calls["n"] += 1
        index = ftt_calls["n"]
        try:
            arrival = SafeAdb.bounds(node)
        except PublisherError:
            arrival = None
        width, height = adapter.viewport

        def inside(bounds):
            return bounds is not None and bounds[0] >= 0 and bounds[1] >= 0 and bounds[2] <= width and bounds[3] <= height

        dumps_before = device.dumps
        log(f"  [candidate #{index}] cd={node.get('content-desc')!r} arrival_bounds={arrival} in_viewport={inside(arrival)} -> re-dumping fresh (up to {re_dumps})")
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
        # 0) accessibility pre-flight, exactly the runner.py:70 gate:
        #    device.ensure_accessibility_healthy() is REQUIRED at the start.
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

        # 1) prepare: identity check + baseline (post count + grid tile signatures)
        device.phase = "prepare"
        adapter.prepare(job, device)
        device.baseline_posts = adapter._baseline_posts
        device.baseline_tiles = adapter._baseline_tiles
        log(f"prepare OK: baseline_posts={device.baseline_posts} baseline_tiles={len(device.baseline_tiles)} wall={wall()}")
        device.save_snapshot("baseline", screenshot=True)

        # 2) transfer media, mirroring runner.run_once
        device.push(LOCAL_VIDEO, REMOTE_VIDEO)
        device.scan_media(REMOTE_VIDEO)
        log(f"media pushed -> {REMOTE_VIDEO} wall={wall()}")

        # 3) publish: full guarded protocol, Share tap is the last publish tap
        device.phase = "publish"
        adapter.publish(job, device, make_checkpoint(device))
        log(f"publish OK: Share tapped; propagation begins (t_share={device.share_tap:.3f} wall={wall()})")

        # 4) verify: 20s -> tab-cycle(3s)+Bezier refresh -> check,
        #    then 20s -> refresh -> check, then 10s -> refresh -> check;
        #    delta recomposes the grid (tab cycle, 1s) before the identity tap
        device.phase = "verify"
        started = time.monotonic()
        identity = adapter.verify(job, device)
        elapsed = time.monotonic() - started
        if identity is None:
            log(f"verify UNVERIFIED wall={wall()}: no positive evidence after {check_index} checks in {elapsed:.1f}s; post stays up, never republished")
            device.save_snapshot("unverified", screenshot=True)
            evidence = getattr(adapter, "verification_evidence", None)
            if evidence is not None:
                (DIAG / "igverify5-unverified-evidence.json").write_text(
                    json.dumps(evidence, indent=2, ensure_ascii=False), encoding="utf-8"
                )
                log("  evidence saved: igverify5-unverified-evidence.json (last dump attached)")
        else:
            log(f"verify OK wall={wall()}: identity={identity!r} verify_elapsed={elapsed:.1f}s (confirmed at check {check_index})")
            device.save_snapshot("verified", screenshot=True)
        if device.delta_dump is not None:
            log(f"DELTA RESULT: dump #{device.delta_dump} of verify, {device.delta_elapsed:.1f}s after Share, tiles {device.delta_counts[0]}->{device.delta_counts[1]}")
        else:
            log("DELTA RESULT: never observed by the harness")
        log(f"swipe log: {device.swipes}")
        log(f"tap count total: {len(device.taps)}")
        log("RESULT: SUCCESS" if identity is not None else "RESULT: UNVERIFIED (publication real, verification pending)")
        return 0 if identity is not None else 2
    except Exception:
        log("ABORTED (fail-closed, no retry):")
        log(traceback.format_exc())
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
