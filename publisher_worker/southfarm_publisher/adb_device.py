from __future__ import annotations

import os
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
    def __init__(self, serial: str, *, adb_path: str = DEFAULT_ADB, run: Callable[..., Any] = subprocess.run, timeout: float = 20.0): self.serial, self.adb_path, self._run, self.timeout = serial, adb_path, run, timeout
    def command(self, *args: str, timeout: float | None = None) -> str:
        try:
            result = self._run([self.adb_path, "-s", self.serial, *args], shell=False, capture_output=True, text=True, timeout=timeout or self.timeout, check=False)
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
        try: return [dict(node.attrib) for node in ET.fromstring(xml).iter("node")]
        except ET.ParseError: raise PublisherError("UI_XML_INVALID", "Device UI dump was invalid", retryable=True) from None
    def dump_ui(self) -> list[dict[str, str]]:
        return self.parse_ui(self.command("exec-out", "uiautomator", "dump", "/dev/tty", timeout=15))
    def screenshot(self, target: str) -> None:
        image = self.binary_command("exec-out", "screencap", "-p", "/dev/stdout", timeout=30)
        if not image: raise PublisherError("SCREENSHOT_EMPTY", "Device screenshot was empty", retryable=True)
        with open(target, "wb") as handle: handle.write(image)
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
    def text(self, value: str) -> None: self.command("shell", "input", "text", value.replace(" ", "%s"))
    def push(self, local: str, remote: str) -> None: self.command("push", local, remote, timeout=120)
    def scan_media(self, remote: str) -> None: self.command("shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", f"file://{remote}")
    def remove(self, remote: str) -> None: self.command("shell", "rm", "-f", remote)
    def foreground_package(self) -> str | None:
        output = self.command("shell", "dumpsys", "activity", "activities")
        match = re.search(r"\bu\d+\s+([A-Za-z0-9_.]+)/", output); return match.group(1) if match else None
    @staticmethod
    def safe_remote_name(name: str) -> str:
        value = re.sub(r"[^A-Za-z0-9._-]", "_", PurePosixPath(name).name)
        if not value or value in {".", ".."}: raise ValueError("remote media name is invalid")
        return value

class AdbDeviceRegistry:
    def __init__(self, *, adb_path: str = DEFAULT_ADB, run: Callable[..., Any] = subprocess.run): self.adb_path, self._run = adb_path, run
    def list_output(self) -> str:
        result = self._run([self.adb_path, "devices", "-l"], shell=False, capture_output=True, text=True, timeout=20, check=False)
        if result.returncode != 0: raise PublisherError("ADB_UNAVAILABLE", "ADB device listing failed", retryable=True)
        return result.stdout or ""
    def devices(self) -> list[AdbDevice]:
        endpoints = []
        for line in self.list_output().splitlines()[1:]:
            parts = line.split()
            if len(parts) >= 2 and parts[1] == "device": endpoints.append(parts[0])
        found = []
        for serial in sorted(endpoints):
            android_id = SafeAdb(serial, adb_path=self.adb_path, run=self._run).android_id()
            if android_id: found.append(AdbDevice(serial, android_id))
        unique: dict[str, AdbDevice] = {}
        for item in found: unique.setdefault(item.android_id, item)
        return list(unique.values())
    def find(self, android_id: str) -> AdbDevice:
        for item in self.devices():
            if item.android_id == android_id: return item
        raise PublisherError("DEVICE_NOT_CONNECTED", "The assigned Android device is unavailable", retryable=True)
    def open(self, android_id: str) -> SafeAdb:
        return SafeAdb(self.find(android_id).serial, adb_path=self.adb_path, run=self._run)
