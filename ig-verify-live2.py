"""ig-verify-live2.py -- second LIVE Instagram publication test on the real phone.

Disposable harness: invokes InstagramPublisher directly with the real SafeAdb
(no backend, no runner). Mirrors runner.py's invocation order:

    prepare -> push+scan media -> publish(checkpoint) -> verify

Second run fixes the known media failure: the first run pushed HEVC 4K files
whose gallery thumbnails never registered the selection tap.  This run pushes
"0730 MA-V-2.mp4" (HEVC 1080x1920, 15.3s -> gallery label "0:15").

Rules honored: authorized account only (marczell.vibes, santilorennzo
forbidden), fail-closed (any PublisherError aborts, NO retry), the post is NOT
deleted afterwards, evidence (raw dumps + screenshots) saved in diag/ with the
igverify2- prefix.

Run:  python ig-verify-live2.py    (cwd: worktree root)
"""

from __future__ import annotations

import hashlib
import re
import subprocess
import sys
import time
import traceback
from pathlib import Path

WORKTREE = Path(__file__).resolve().parent
sys.path.insert(0, str(WORKTREE / "publisher_worker"))

from southfarm_publisher.adb_device import DEFAULT_ADB, SafeAdb  # noqa: E402
from southfarm_publisher.models import PublicationJob  # noqa: E402
from southfarm_publisher.platforms import InstagramPublisher  # noqa: E402

SERIAL = "863d00583048313238510ca492874c"
EXPECTED_ACCOUNT = "marczell.vibes"
FORBIDDEN = {"santilorennzo"}
LOCAL_VIDEO = r"C:\Users\josu_\Downloads\Videos to test\0730 MA-V-2.mp4"
REMOTE_VIDEO = "/sdcard/Movies/SouthFarm/igverify-live2.mp4"
DIAG = WORKTREE / "diag"
DIAG.mkdir(exist_ok=True)
LOG_PATH = DIAG / "igverify2-live.log"

# The adapter hard-caps captions at 10 words (validate_caption); 10 it is.
# New caption (mindset/motivational), distinct from the previous runs'
# "Stay hungry, stay humble..." and "Stay present, tomorrow is not promised".
CAPTION = "Consistency compounds quietly so show up and do the work"

POST_COUNT_RID = "com.instagram.android:id/profile_header_post_count_front_familiar"
GRID_TILE = re.compile(r"Reel by .+ at row \d+, column \d+")


def log(message: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {message}"
    print(line, flush=True)
    with open(LOG_PATH, "a", encoding="utf-8") as handle:
        handle.write(line + "\n")


class EvidenceDevice:
    """SafeAdb facade that records raw dump XML + screenshots into diag/.

    Also instruments taps and swipes so the report can state exactly what the
    adapter did (which swipe mechanism, at which moment the Share tap landed,
    and on which dump / at how many seconds after Share the delta appeared).
    """

    def __init__(self, inner: SafeAdb) -> None:
        self._inner = inner
        self.dumps = 0
        self.last_seq = inner._last_dump_seq
        self.phase = "setup"
        self.baseline_posts: int | None = None
        self.baseline_tiles: frozenset[str] = frozenset()
        self.share_tap: float | None = None
        self.pending_share = False
        self.taps: list[tuple[float, tuple[int, int, int, int]]] = []
        self.swipes: list[tuple[str, float, tuple[int, ...]]] = []
        self.delta_dump: int | None = None
        self.delta_elapsed: float | None = None
        self.delta_counts: tuple[int, int] | None = None

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def tap_bounds(self, bounds, delay_seconds=0.2):
        now = time.monotonic()
        self.taps.append((now, tuple(bounds)))
        if self.pending_share:
            self.share_tap = now
            self.pending_share = False
            log(f"  SHARE TAP at t={now:.3f}")
        log(f"  [tap #{len(self.taps)}] center=({(bounds[0] + bounds[2]) // 2},{(bounds[1] + bounds[3]) // 2})")
        return self._inner.tap_bounds(bounds, delay_seconds)

    def swipe_bezier(self, x1, y1, x2, y2, duration_ms=400):
        self.swipes.append(("bezier", time.monotonic(), (x1, y1, x2, y2, duration_ms)))
        self._inner.swipe_bezier(x1, y1, x2, y2, duration_ms)
        mode = "motionevent" if self._inner._motionevent_support else "fallback-straight"
        log(f"  [swipe-bezier {mode}] {x1},{y1} -> {x2},{y2} {duration_ms}ms")
        return None

    def swipe(self, x1, y1, x2, y2, duration_ms=300):
        self.swipes.append(("straight", time.monotonic(), (x1, y1, x2, y2, duration_ms)))
        log(f"  [swipe-straight] {x1},{y1} -> {x2},{y2} {duration_ms}ms")
        return self._inner.swipe(x1, y1, x2, y2, duration_ms)

    def dump_ui(self):
        nodes = self._inner.dump_ui()
        self.dumps += 1
        seq = self._inner._last_dump_seq
        if seq == self.last_seq:
            log(f"  ANOMALY: dump #{self.dumps} accepted a non-incrementing seq={seq} (stale fallback)")
        self.last_seq = seq
        if self.phase == "verify":
            self._check_delta(nodes)
            if self.dumps % 10 == 0:
                self.save_snapshot(f"verify-{self.dumps:03d}", screenshot=(self.dumps % 20 == 0))
        return nodes

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
                f"  DELTA DETECTED at dump #{self.dumps}: new_tiles={sorted(tiles - self.baseline_tiles)} "
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
            (DIAG / f"igverify2-{name}.xml").write_bytes(xml)
        if screenshot:
            self._inner.screenshot(str(DIAG / f"igverify2-{name}.png"))
        log(f"  evidence saved: igverify2-{name}.xml" + (" + .png" if screenshot else ""))


def make_checkpoint(device: EvidenceDevice):
    def checkpoint(step, progress, final_action=False, evidence=None):
        log(f"checkpoint {step} progress={progress} final_action={final_action} evidence={evidence}")
        if final_action:
            device.pending_share = True
            device.save_snapshot("share-screen", screenshot=True)
    return checkpoint


def media_metadata(path: str) -> dict:
    data = Path(path).read_bytes()
    return {
        "id": 999002,
        "size_bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "mime_type": "video/mp4",
        "file_extension": "mp4",
        "duration_seconds": 15,  # ffprobe: 15.333s -> gallery label "0:15"
        "width": 1080,
        "height": 1920,
        "video_codec": "hevc",
        "audio_codec": "aac",
    }


def main() -> int:
    if LOG_PATH.exists():
        LOG_PATH.unlink()
    log(f"ig-verify-live2 start: serial={SERIAL} account={EXPECTED_ACCOUNT} video={LOCAL_VIDEO}")
    log(f"caption ({len(CAPTION.split())} words): {CAPTION!r}")
    if not Path(LOCAL_VIDEO).is_file():
        log("ABORTED: local video file is missing")
        return 1
    device = EvidenceDevice(SafeAdb(SERIAL, ui_source="service"))
    adapter = InstagramPublisher(expected_account=EXPECTED_ACCOUNT, forbidden_accounts=FORBIDDEN)
    job = PublicationJob(
        id=999002,
        device_id=1,
        media_id=999002,
        platform="instagram",
        caption=CAPTION,
        media=media_metadata(LOCAL_VIDEO),
        account={"id": 1, "username": EXPECTED_ACCOUNT, "display_name": "Marczellvibes", "platform": "instagram"},
        device={"id": 1, "device_id": SERIAL},
    )
    try:
        # 1) prepare: identity check + baseline (post count + grid tile signatures)
        device.phase = "prepare"
        adapter.prepare(job, device)
        device.baseline_posts = adapter._baseline_posts
        device.baseline_tiles = adapter._baseline_tiles
        log(f"prepare OK: baseline_posts={device.baseline_posts} baseline_tiles={len(device.baseline_tiles)}")
        device.save_snapshot("baseline", screenshot=True)

        # 2) transfer media, mirroring runner.run_once
        device.push(LOCAL_VIDEO, REMOTE_VIDEO)
        device.scan_media(REMOTE_VIDEO)
        log(f"media pushed -> {REMOTE_VIDEO}")

        # 3) publish: full guarded protocol, Share tap is the last publish tap
        device.phase = "publish"
        adapter.publish(job, device, make_checkpoint(device))
        log(f"publish OK: Share tapped; propagation begins (t_share={device.share_tap:.3f})")

        # 4) verify: 180s deadline, tab-cycle + Bezier swipe re-sync, delta phase
        device.phase = "verify"
        started = time.monotonic()
        identity = adapter.verify(job, device)
        log(f"verify OK: identity={identity!r} verify_elapsed={time.monotonic() - started:.1f}s")
        device.save_snapshot("verified", screenshot=True)
        if device.delta_dump is not None:
            log(f"DELTA RESULT: dump #{device.delta_dump} of verify, {device.delta_elapsed:.1f}s after Share, tiles {device.delta_counts[0]}->{device.delta_counts[1]}")
        else:
            log("DELTA RESULT: never observed by the harness")
        log(f"swipe log: {device.swipes}")
        log(f"tap count total: {len(device.taps)}")
        log("RESULT: SUCCESS")
        return 0
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
