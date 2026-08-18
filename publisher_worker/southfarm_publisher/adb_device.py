from __future__ import annotations

import os
import random
import re
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any, Callable

from .models import PublisherError

DEFAULT_ADB = r"C:\SouthFarm\toolchain\android-sdk\platform-tools\adb.exe"
BOUNDS = re.compile(r"^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$")

@dataclass(frozen=True)
class AdbDevice: serial: str; android_id: str

class SafeAdb:
    SERVICE_DUMP_PATH = "/sdcard/Android/data/com.example.southfarm_app/files/southfarm_ui.xml"
    SERVICE_DUMP_COMPONENT = "com.example.southfarm_app/.WarmupReceiver"
    SERVICE_DUMP_ACTION = "com.example.southfarm_app.DUMP_UI"
    SERVICE_DUMP_DEADLINE_SECONDS = 8.0
    SERVICE_DUMP_POLL_SECONDS = 0.25
    SERVICE_DUMP_COMMAND_TIMEOUT = 3.0
    SERVICE_DUMP_INITIAL_DELAY_SECONDS = 0.3
    # Accessibility-service health repair (the service has woken up crashed
    # under dumpsys "Crashed services" while the enabled settings still read
    # 1).  The shorthand is the `am` component form; the flat component is
    # the canonical settings-value form.
    SERVICE_PACKAGE = "com.example.southfarm_app"
    SERVICE_COMPONENT = "com.example.southfarm_app/.SouthFarmAccessibilityService"
    SERVICE_FLAT_COMPONENT = "com.example.southfarm_app/com.example.southfarm_app.SouthFarmAccessibilityService"
    SERVICE_REBIND_TIMEOUT_SECONDS = 15.0
    SERVICE_REBIND_POLL_SECONDS = 1.0
    # Dump-free grace window between the settings re-set and the first
    # post-repair dump: polling with dump broadcasts during the rebind
    # interferes with it on HyperOS (the 2026-08-17 live failure was repaired
    # by waiting ~6s without any dump before re-verifying).
    SERVICE_REBIND_GRACE_SECONDS = 6.0
    # Connectivity pre-flight: one bounded ping of the public DNS anycast
    # address, with `dumpsys connectivity` as the arbiter fallback when the
    # ping cannot prove a working link (no echo reply, ping unavailable, or
    # ICMP blocked).  Both probes must fail before DEVICE_OFFLINE is raised.
    NETWORK_PING_TARGET = "8.8.8.8"
    NETWORK_PING_COMMAND_TIMEOUT = 15.0
    NETWORK_DUMPSYS_COMMAND_TIMEOUT = 15.0

    def __init__(self, serial: str, *, adb_path: str = DEFAULT_ADB, run: Callable[..., Any] = subprocess.run, timeout: float = 20.0, ui_source: str = "service", pause: Callable[[float], None] = time.sleep):
        if ui_source not in ("service", "uiautomator"): raise PublisherError("CONFIG_INVALID", "ui_source must be 'service' or 'uiautomator'")
        self.serial, self.adb_path, self._run, self.timeout, self.ui_source, self._pause = serial, adb_path, run, timeout, ui_source, pause
        # Highest service-dump seq accepted so far; the app stamps each dump
        # with a monotonic seq on <hierarchy> so leftovers from a previous
        # request (whose renameTo raced past our rm) can be told apart.
        self._last_dump_seq: int = 0
        # `input motionevent` support is probed once and cached; unsupported
        # devices fall back to the straight `input swipe`.
        self._motionevent_support: bool | None = None
    def command(self, *args: str, timeout: float | None = None) -> str:
        try:
            result = self._run([self.adb_path, "-s", self.serial, *args], shell=False, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout or self.timeout, check=False)
        except (OSError, subprocess.TimeoutExpired): raise PublisherError("ADB_UNAVAILABLE", "ADB command failed", retryable=True) from None
        if result.returncode != 0: raise PublisherError("ADB_COMMAND_FAILED", "ADB command failed", retryable=True)
        return result.stdout or ""
    def binary_command(self, *args: str, timeout: float | None = None) -> bytes:
        try:
            result = self._run([self.adb_path, "-s", self.serial, *args], shell=False, capture_output=True, timeout=timeout or self.timeout, check=False)
        except (OSError, subprocess.TimeoutExpired): raise PublisherError("ADB_UNAVAILABLE", "ADB command failed", retryable=True) from None
        if result.returncode != 0: raise PublisherError("ADB_COMMAND_FAILED", "ADB command failed", retryable=True)
        return bytes(result.stdout or b"")
    def android_id(self) -> str: return self.command("shell", "settings", "get", "secure", "android_id").strip()
    @staticmethod
    def parse_ui(xml: str) -> list[dict[str, str]]:
        try:
            cleaned = re.sub(r"(</hierarchy>)\s*UI (?:hierchary|hierarchy) dumped to: /dev/tty\s*$", r"\1", xml.strip())
            nodes = [dict(node.attrib) for node in ET.fromstring(cleaned).iter("node")]
        except ET.ParseError: raise PublisherError("UI_XML_INVALID", "Device UI dump was invalid", retryable=True) from None
        # Defense in depth: a legacy or hostile dump may serialize the same
        # window tree several times; exact-duplicate attribute dicts would
        # collide the worker's selectors, so keep only the first copy.
        unique: dict[frozenset, dict[str, str]] = {}
        for node in nodes: unique.setdefault(frozenset(node.items()), node)
        return list(unique.values())
    def dump_ui(self) -> list[dict[str, str]]:
        return self.dump_ui_explicit(self.ui_source)
    def dump_ui_explicit(self, source: str) -> list[dict[str, str]]:
        """Force ONE dump via `source`, regardless of the configured default.

        Screens protected by Google (for example YouTube Add details) return an
        empty tree on the accessibility-service dump, so callers need a one-off
        uiautomator dump while every other screen keeps the service default.
        """
        if source not in ("service", "uiautomator"): raise PublisherError("CONFIG_INVALID", "dump source must be 'service' or 'uiautomator'")
        if source == "service": return self._service_dump_ui()
        return self.parse_ui(self.command("exec-out", "uiautomator", "dump", "/dev/tty", timeout=15))
    def _service_dump_ui(self, *, require_fresh: bool = False) -> list[dict[str, str]]:
        # The accessibility-service dump is atomic (tmp+rename): once `cat`
        # returns content the document is complete.  Paths travel as subprocess
        # argv entries (no shell), so no MSYS path conversion applies.
        self.command("shell", "rm", "-f", self.SERVICE_DUMP_PATH, timeout=self.SERVICE_DUMP_COMMAND_TIMEOUT)
        self.command("shell", "am", "broadcast", "-n", self.SERVICE_DUMP_COMPONENT, "-a", self.SERVICE_DUMP_ACTION, timeout=self.SERVICE_DUMP_COMMAND_TIMEOUT)
        # The app needs ~0.9s to write the dump: skip the obviously-lost first
        # poll instead of burning a doomed `cat` at t≈0.
        self._pause(self.SERVICE_DUMP_INITIAL_DELAY_SECONDS)
        deadline = time.monotonic() + self.SERVICE_DUMP_DEADLINE_SECONDS
        stale_xml = ""
        while True:
            xml = self._poll_cat()
            if xml.strip():
                seq = self._dump_seq(xml)
                # A seq at or below the last accepted one is a tree from a
                # previous request whose renameTo landed after our rm: keep
                # polling until this request's own dump overwrites it.  XML
                # without seq comes from an older app build: accept directly.
                if seq is None or seq > self._last_dump_seq:
                    if seq is not None: self._last_dump_seq = seq
                    return self.parse_ui(xml)
                stale_xml = xml
            if time.monotonic() >= deadline:
                if stale_xml and not require_fresh:
                    # The fresh dump never landed within the deadline; the
                    # newest stale tree still beats failing the whole dump.
                    # The health check opts out (require_fresh): a stale tree
                    # is exactly the dead-service signal it is probing for.
                    stale_seq = self._dump_seq(stale_xml)
                    if stale_seq is not None: self._last_dump_seq = stale_seq
                    return self.parse_ui(stale_xml)
                raise PublisherError("UI_DUMP_UNAVAILABLE", "Accessibility service UI dump is unavailable", retryable=True)
            self._pause(self.SERVICE_DUMP_POLL_SECONDS)
    def _poll_cat(self) -> str:
        """One polling `cat` of the dump file, racing the app's writer.

        `adb shell cat` exits rc=1 while the file does not exist yet; that is
        a normal race, not a worker-fatal ADB failure.  rm/broadcast still
        fail hard through `command`; this poll only reports content, and any
        failure (bad rc, transport error, timeout) reads as "not yet".
        """
        try:
            result = self._run([self.adb_path, "-s", self.serial, "shell", "cat", self.SERVICE_DUMP_PATH], shell=False, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=self.SERVICE_DUMP_COMMAND_TIMEOUT, check=False)
        except (OSError, subprocess.TimeoutExpired):
            return ""
        return result.stdout if result.returncode == 0 else ""

    @staticmethod
    def _dump_seq(xml: str) -> int | None:
        # seq lives on <hierarchy>, a couple of lines into the document; a
        # regex over the head avoids a full XML parse of a large tree just to
        # read one freshness attribute (and tolerates a truncated tail).
        match = re.search(r'seq="(\d+)"', xml[:200])
        return int(match.group(1)) if match else None

    def _service_answers(self) -> bool:
        """Does the accessibility service answer one fresh dump right now?

        A fresh seq proves the service processed THIS request; a stale tree
        served at the deadline (or no dump at all) reads as a dead service.
        Transport failures still propagate: a broken ADB link is a worker
        failure, not a service-health verdict.
        """
        try:
            self._service_dump_ui(require_fresh=True)
            return True
        except PublisherError as error:
            if error.code != "UI_DUMP_UNAVAILABLE":
                raise
            return False

    @staticmethod
    def _flat_component(value: str) -> str:
        """Normalize the 'pkg/.Class' shorthand into canonical 'pkg/pkg.Class'."""
        if "/" not in value:
            return value
        package, cls = value.split("/", 1)
        if cls.startswith("."):
            cls = package + cls
        return f"{package}/{cls}"

    def _enabled_accessibility_services(self) -> list[str]:
        current = self.command("shell", "settings", "get", "secure", "enabled_accessibility_services").strip()
        if not current or current == "null":
            return []
        return [item.strip() for item in current.split(":") if item.strip()]

    def _repair_accessibility_service(self) -> bool:
        """One repair attempt for a crashed accessibility service.

        Live-proven sequence (2026-08-17, HyperOS): force-stop the app,
        write enabled_accessibility_services EXPLICITLY as the preserved
        other services plus our canonical flat component -- never a verbatim
        re-write of the read value, because HyperOS can null the setting
        after failed binds and only the explicit canonical write rebinds the
        service -- set accessibility_enabled 1, then wait a fixed grace
        window WITHOUT any dump broadcast (polling during the rebind
        interferes with it) and only then re-verify with fresh dumps for the
        rebind timeout.  Returns True once the service answers again, False
        when it stays dead.  The rebind is never force-timed: each poll is a
        real fresh dump request.
        """
        services = self._enabled_accessibility_services()
        flat = self._flat_component(self.SERVICE_COMPONENT)
        preserved = [item for item in services if self._flat_component(item) != flat]
        self.command("shell", "am", "force-stop", self.SERVICE_PACKAGE)
        self.command("shell", "settings", "put", "secure", "enabled_accessibility_services", ":".join([*preserved, self.SERVICE_FLAT_COMPONENT]))
        self.command("shell", "settings", "put", "secure", "accessibility_enabled", "1")
        self._pause(self.SERVICE_REBIND_GRACE_SECONDS)
        deadline = time.monotonic() + self.SERVICE_REBIND_TIMEOUT_SECONDS
        while True:
            if self._service_answers():
                return True
            if time.monotonic() >= deadline:
                return False
            self._pause(self.SERVICE_REBIND_POLL_SECONDS)

    def ensure_accessibility_healthy(self) -> None:
        """Prove the accessibility service answers before any app is opened.

        The service has woken up crashed/frozen ("Crashed services" in
        dumpsys while the enabled settings still read 1, or a nulled
        enabled_accessibility_services after HyperOS failed binds): DUMP_UI
        requests went unanswered and every UI dump stalled the job.  This
        pre-flight checks one broadcast + fresh-seq dump; a dead service is
        repaired ONCE (force-stop + explicit canonical component write +
        accessibility_enabled 1 + a dump-free grace window + rebind wait)
        and re-verified.  Only a service that stays dead after the repair
        aborts with ACCESSIBILITY_SERVICE_DOWN (retryable) -- before any
        social app is opened.  uiautomator-only configurations never depend
        on the service and skip the check.
        """
        if self.ui_source != "service":
            return
        if self._service_answers():
            return
        if not self._repair_accessibility_service():
            raise PublisherError("ACCESSIBILITY_SERVICE_DOWN", "SouthFarm accessibility service did not answer a fresh UI dump even after repair", retryable=True)

    def _ping_answered(self) -> bool:
        """One bounded ICMP probe: `shell ping -c 2 -W 2 8.8.8.8` answered?

        A zero exit means at least one echo reply arrived.  Transport
        failures and non-zero exits read as "not proven" and fall through
        to the dumpsys connectivity check -- the arbiter between a dead
        link and a link where ping is simply unavailable or ICMP is
        blocked.
        """
        try:
            result = self._run(
                [self.adb_path, "-s", self.serial, "shell", "ping", "-c", "2", "-W", "2", self.NETWORK_PING_TARGET],
                shell=False, capture_output=True, text=True, encoding="utf-8", errors="replace",
                timeout=self.NETWORK_PING_COMMAND_TIMEOUT, check=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return False
        return result.returncode == 0

    def _connectivity_validated(self) -> bool:
        """Does dumpsys report an active default network in a usable state?

        The ping fallback: ICMP is sometimes blocked or `ping` unavailable
        even while the link works.  An "Active default network" line that
        names a real network, plus a VALIDATED ConnectivityState somewhere
        in the dump, reads as a working link.
        """
        output = self.command("shell", "dumpsys", "connectivity", timeout=self.NETWORK_DUMPSYS_COMMAND_TIMEOUT)
        active = re.search(r"Active default network:\s*(\S+)", output)
        if active is None or active.group(1).casefold() in {"none", "null"}:
            return False
        return "VALIDATED" in output

    def ensure_network_up(self) -> None:
        """Pre-flight connectivity gate: abort DEVICE_OFFLINE before any app or media work.

        The 2026-08-17 live run lost WiFi mid-publication and the Post tap
        ended in a forever-"Posting... 0%" overlay.  A device that is
        already offline must never consume a media push or an app launch:
        the runner calls this right after ensure_accessibility_healthy and
        before any adapter or media operation.

        Mechanism: primary probe `adb shell ping -c 2 -W 2 8.8.8.8`
        (rc 0 = at least one echo reply).  When ping cannot prove the link
        (non-zero exit, transport failure, ping missing, ICMP blocked) the
        fallback is `dumpsys connectivity`: an active default network with
        a VALIDATED ConnectivityState counts as up.  Only when NEITHER
        probe confirms connectivity does this raise DEVICE_OFFLINE
        (retryable).
        """
        if self._ping_answered():
            return
        if self._connectivity_validated():
            return
        raise PublisherError("DEVICE_OFFLINE", "The device has no working network connectivity", retryable=True)

    def screenshot(self, target: str) -> None:
        destination = os.path.abspath(target)
        if not destination.lower().endswith(".png") or not os.path.isdir(os.path.dirname(destination)): raise ValueError("screenshot target must be an existing PNG path")
        image = self.binary_command("exec-out", "screencap", "-p", "/dev/stdout", timeout=30)
        if not image: raise PublisherError("SCREENSHOT_EMPTY", "Device screenshot was empty", retryable=True)
        with open(destination, "wb") as handle: handle.write(image)
    @staticmethod
    def find_exact(nodes: list[dict[str, str]], *, text: str | None = None, content_desc: str | None = None, resource_id: str | None = None) -> dict[str, str] | None:
        for node in nodes:
            if text is not None and node.get("text") != text: continue
            if content_desc is not None and node.get("content-desc") != content_desc: continue
            if resource_id is not None and node.get("resource-id") != resource_id: continue
            return node
        return None
    @staticmethod
    def bounds(node: dict[str, str]) -> tuple[int, int, int, int]:
        match = BOUNDS.match(node.get("bounds", ""));
        if not match: raise PublisherError("UI_BOUNDS_INVALID", "Device control has invalid bounds")
        values = tuple(map(int, match.groups()))
        if values[0] >= values[2] or values[1] >= values[3]: raise PublisherError("UI_BOUNDS_INVALID", "Device control has invalid bounds")
        return values
    def tap_bounds(self, bounds: tuple[int, int, int, int], delay_seconds: float = 0.2) -> None:
        x1,y1,x2,y2 = bounds; self.command("shell", "input", "tap", str((x1+x2)//2), str((y1+y2)//2)); time.sleep(max(0.0, min(delay_seconds, 2.0)))
    def back(self) -> None: self.command("shell", "input", "keyevent", "4")
    def swipe(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int = 300) -> None:
        if not all(isinstance(value, int) and 0 <= value <= 10000 for value in (x1, y1, x2, y2)) or not 50 <= duration_ms <= 2000:
            raise ValueError("swipe coordinates are invalid")
        self.command("shell", "input", "swipe", str(x1), str(y1), str(x2), str(y2), str(duration_ms))

    _BEZIER_SAMPLES = 20  # ~15-25 points along the cubic, endpoints included

    def swipe_bezier(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int = 400) -> None:
        """Human-like swipe along a cubic Bezier, dispatched as motionevents.

        Replicates the gesture math of the on-device accessibility service
        (SouthFarmAccessibilityService.swipe): cubicTo with control points at
        25%/75% of the vertical travel and x-jitter of
        (random.nextFloat()-0.5)*24 on each control point, exact endpoints.
        The cubic is sampled into ~20 integer points and dispatched as
        `adb shell input motionevent DOWN/MOVE.../UP`.  Devices whose `input`
        does not document motionevent (probed once, cached) fall back to the
        straight `input swipe` -- never to a failure or a blind tap.
        """
        if not all(isinstance(value, int) and 0 <= value <= 10000 for value in (x1, y1, x2, y2)) or not 50 <= duration_ms <= 2000:
            raise ValueError("swipe coordinates are invalid")
        if self._motionevent_support is None:
            self._motionevent_support = self._probe_motionevent()
        if not self._motionevent_support:
            self.swipe(x1, y1, x2, y2, duration_ms)
            return
        def jitter() -> float:
            return (random.random() - 0.5) * 24.0
        control1 = (x1 + (x2 - x1) * 0.25 + jitter(), y1 - (y1 - y2) * 0.25)
        control2 = (x2 + jitter(), y1 - (y1 - y2) * 0.75)
        points = self._bezier_samples(x1, y1, control1[0], control1[1], control2[0], control2[1], x2, y2, self._BEZIER_SAMPLES)
        self.command("shell", "input", "motionevent", "DOWN", str(points[0][0]), str(points[0][1]))
        step = (duration_ms / 1000.0) / (len(points) - 1)
        for px, py in points[1:]:
            self._pause(step)
            self.command("shell", "input", "motionevent", "MOVE", str(px), str(py))
        self._pause(step)
        self.command("shell", "input", "motionevent", "UP", str(points[-1][0]), str(points[-1][1]))

    def _probe_motionevent(self) -> bool:
        """Does this device's `input` binary document motionevent?

        `input` with no arguments prints its usage.  The probe never raises:
        an unreadable or undocumented binary reads as unsupported, and every
        subsequent swipe stays on the straight fallback (fail-safe direction).
        """
        try:
            result = self._run([self.adb_path, "-s", self.serial, "shell", "input"], shell=False, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10, check=False)
        except (OSError, subprocess.TimeoutExpired):
            return False
        usage = f"{result.stdout or ''}\n{result.stderr or ''}".casefold()
        return "motionevent" in usage

    @staticmethod
    def _bezier_samples(x0: float, y0: float, cx1: float, cy1: float, cx2: float, cy2: float, x3: float, y3: float, samples: int) -> list[tuple[int, int]]:
        """Sample a cubic Bezier at `samples` evenly spaced t values, as integers."""
        points: list[tuple[int, int]] = []
        for index in range(samples):
            t = index / (samples - 1)
            u = 1.0 - t
            x = u * u * u * x0 + 3 * u * u * t * cx1 + 3 * u * t * t * cx2 + t * t * t * x3
            y = u * u * u * y0 + 3 * u * u * t * cy1 + 3 * u * t * t * cy2 + t * t * t * y3
            points.append((int(round(x)), int(round(y))))
        return points
    def text(self, value: str) -> None:
        if not value or any(char in value for char in "\x00\n\r;&|`$<>()\\\"") or not re.fullmatch(r"[\w .,!?'#@%:+\-]+", value, re.UNICODE): raise ValueError("text contains unsafe characters")
        self.command("shell", "input", "text", value.replace(" ", "%s"))
    @staticmethod
    def safe_remote_path(remote: str) -> str:
        root = "/sdcard/Movies/SouthFarm/"
        if not remote.startswith(root): raise ValueError("remote path must stay in SouthFarm directory")
        return root + SafeAdb.safe_remote_name(remote[len(root):])
    def push(self, local: str, remote: str) -> None: self.command("push", local, self.safe_remote_path(remote), timeout=120)
    def scan_media(self, remote: str) -> None:
        safe = self.safe_remote_path(remote); self.command("shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", f"file://{safe}")
    def remove(self, remote: str) -> None: self.command("shell", "rm", "-f", self.safe_remote_path(remote))
    def foreground_package(self) -> str | None:
        output = self.command("shell", "dumpsys", "activity", "activities")
        match = re.search(r"\bu\d+\s+([A-Za-z0-9_.]+)/", output); return match.group(1) if match else None
    @staticmethod
    def safe_remote_name(name: str) -> str:
        value = re.sub(r"[^A-Za-z0-9._-]", "_", PurePosixPath(name).name)
        if not value or value in {".", ".."}: raise ValueError("remote media name is invalid")
        return value

class AdbDeviceRegistry:
    def __init__(self, *, adb_path: str = DEFAULT_ADB, run: Callable[..., Any] = subprocess.run, expected_serial: str | None = None, expected_android_id: str | None = None, expected_backend_device_id: str | None = None, ui_source: str = "service"):
        self.adb_path, self._run, self.expected_serial, self.expected_android_id = adb_path, run, expected_serial, expected_android_id
        self.expected_backend_device_id = expected_backend_device_id or expected_android_id
        self.ui_source = ui_source
    def list_output(self) -> str:
        result = self._run([self.adb_path, "devices", "-l"], shell=False, capture_output=True, text=True, timeout=20, check=False)
        if result.returncode != 0: raise PublisherError("ADB_UNAVAILABLE", "ADB device listing failed", retryable=True)
        return result.stdout or ""
    def devices(self) -> list[AdbDevice]:
        endpoints = []
        for line in self.list_output().splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 2 and parts[1] == "device" and (self.expected_serial is None or parts[0] == self.expected_serial): endpoints.append(parts[0])
        found = []
        for serial in sorted(endpoints):
            android_id = SafeAdb(serial, adb_path=self.adb_path, run=self._run).android_id()
            if android_id and (self.expected_android_id is None or android_id == self.expected_android_id): found.append(AdbDevice(serial, android_id))
        unique: dict[str, AdbDevice] = {}
        for item in found: unique.setdefault(item.android_id, item)
        return list(unique.values())
    def find(self, backend_device_id: str) -> AdbDevice:
        if self.expected_backend_device_id is not None and backend_device_id != self.expected_backend_device_id:
            raise PublisherError("DEVICE_IDENTITY_MISMATCH", "Backend device identity does not match configured Android device")
        devices = self.devices()
        if devices: return devices[0]
        raise PublisherError("DEVICE_NOT_CONNECTED", "The assigned Android device is unavailable", retryable=True)
    def open(self, backend_device_id: str) -> SafeAdb:
        return SafeAdb(self.find(backend_device_id).serial, adb_path=self.adb_path, run=self._run, ui_source=self.ui_source)
