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

    def test_remote_path_is_sanitized(self):
        self.assertEqual(SafeAdb.safe_remote_name("../../clip name.mp4"), "clip_name.mp4")
        with self.assertRaises(ValueError): SafeAdb.safe_remote_name("..").__str__()
