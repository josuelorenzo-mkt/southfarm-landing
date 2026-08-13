import subprocess
import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from southfarm_publisher.adb_device import AdbDevice, AdbDeviceRegistry, SafeAdb


class FakeRun:
    def __init__(self): self.calls = []
    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if argv[-3:] == ["settings", "get", "secure"]: return subprocess.CompletedProcess(argv, 0, "", "")
        if argv[-1] == "android_id":
            serial = argv[argv.index("-s") + 1]
            values = {"usb": "android-1\n", "wifi": "android-1\n", "offline": "nope\n"}
            return subprocess.CompletedProcess(argv, 0, values.get(serial, "\n"), "")
        return subprocess.CompletedProcess(argv, 0, "", "")


class AdbDeviceTests(unittest.TestCase):
    def test_registry_maps_android_id_and_collapses_duplicate_endpoints(self):
        fake = FakeRun()
        registry = AdbDeviceRegistry(run=fake, adb_path="adb-test")
        registry.list_output = lambda: "List of devices attached\nusb\tdevice product:x\nwifi\tdevice product:x\nunauth\tunauthorized\noffline\toffline\n"
        found = registry.find("android-1")
        self.assertEqual(found, AdbDevice(serial="usb", android_id="android-1"))
        self.assertEqual([call[0] for call in fake.calls][0], ["adb-test", "-s", "usb", "shell", "settings", "get", "secure", "android_id"])
        self.assertTrue(all(call[1]["shell"] is False for call in fake.calls))

    def test_safe_adb_uses_argv_and_parses_exact_semantic_nodes(self):
        fake = FakeRun(); adb = SafeAdb("serial-1", run=fake, adb_path="adb-test")
        xml = '<hierarchy><node text="Next" content-desc="" resource-id="x" clickable="true" bounds="[1,2][30,40]"/><node text="Next step" resource-id="y" clickable="true" bounds="[1,2][30,40]"/></hierarchy>'
        nodes = adb.parse_ui(xml)
        self.assertEqual(adb.find_exact(nodes, text="Next")["resource-id"], "x")
        adb.tap_bounds((1, 2, 30, 40), delay_seconds=0)
        self.assertEqual(fake.calls[-1][0], ["adb-test", "-s", "serial-1", "shell", "input", "tap", "15", "21"])
        self.assertFalse(fake.calls[-1][1]["shell"])
        adb.back(); self.assertEqual(fake.calls[-1][0], ["adb-test", "-s", "serial-1", "shell", "input", "keyevent", "4"])
        adb.swipe(900, 900, 100, 900, 300); self.assertEqual(fake.calls[-1][0], ["adb-test", "-s", "serial-1", "shell", "input", "swipe", "900", "900", "100", "900", "300"])

    def test_dump_and_screenshot_use_bounded_argv_commands(self):
        class DeviceRun(FakeRun):
            def __call__(self, argv, **kwargs):
                self.calls.append((argv, kwargs))
                if argv[-3:] == ["uiautomator", "dump", "/dev/tty"]:
                    return subprocess.CompletedProcess(argv, 0, '<hierarchy><node text="Ready" bounds="[0,0][1,1]"/></hierarchy>', "")
                if argv[-3:] == ["screencap", "-p", "/dev/stdout"]:
                    return subprocess.CompletedProcess(argv, 0, b"PNG", b"")
                return subprocess.CompletedProcess(argv, 0, "", "")
        fake = DeviceRun(); adb = SafeAdb("serial-1", run=fake, adb_path="adb-test")
        self.assertEqual(adb.dump_ui()[0]["text"], "Ready")
        with self.subTest("screenshot"):
            import tempfile
            target = tempfile.mktemp(suffix=".png")
            try:
                adb.screenshot(target)
                with open(target, "rb") as handle: self.assertEqual(handle.read(), b"PNG")
            finally:
                import os
                if os.path.exists(target): os.unlink(target)

    def test_remote_path_is_sanitized(self):
        self.assertEqual(SafeAdb.safe_remote_name("../../clip name.mp4"), "clip_name.mp4")
        with self.assertRaises(ValueError): SafeAdb.safe_remote_name("..").__str__()
    def test_text_and_remote_operations_reject_unsafe_inputs(self):
        adb = SafeAdb("serial-1", run=FakeRun(), adb_path="adb-test")
        with self.assertRaises(ValueError): adb.text("unsafe; rm")
        with self.assertRaises(ValueError): adb.remove("/sdcard/Download/clip.mp4")
