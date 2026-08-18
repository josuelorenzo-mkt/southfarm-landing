import subprocess
import sys
from pathlib import Path
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from southfarm_publisher.adb_device import AdbDevice, AdbDeviceRegistry, SafeAdb
from southfarm_publisher.models import PublisherError


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


class ServiceDumpRun:
    def __init__(self, xml, empty_cats=1): self.xml, self.empty_cats, self.calls, self.cats = xml, empty_cats, [], 0
    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if "rm" in argv: return subprocess.CompletedProcess(argv, 0, "", "")
        if "broadcast" in argv: return subprocess.CompletedProcess(argv, 0, "", "")
        if "cat" in argv:
            self.cats += 1
            return subprocess.CompletedProcess(argv, 0, self.xml if self.cats > self.empty_cats else "", "")
        return subprocess.CompletedProcess(argv, 0, "", "")


class SeqDumpRun:
    """Serves queued `cat` payloads per dump round; `rm` restarts the queue and the last payload repeats."""
    def __init__(self, *payloads): self.payloads, self.calls, self.cats = list(payloads), [], 0
    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if "rm" in argv: self.cats = 0
        if "cat" not in argv: return subprocess.CompletedProcess(argv, 0, "", "")
        payload = self.payloads[min(self.cats, len(self.payloads) - 1)]; self.cats += 1
        return subprocess.CompletedProcess(argv, 0, payload, "")


class AdbDeviceTests(unittest.TestCase):
    def test_registry_maps_android_id_and_collapses_duplicate_endpoints(self):
        fake = FakeRun()
        registry = AdbDeviceRegistry(run=fake, adb_path="adb-test")
        registry.list_output = lambda: "List of devices attached\nusb\tdevice product:x\nwifi\tdevice product:x\nunauth\tunauthorized\noffline\toffline\n"
        found = registry.find("android-1")
        self.assertEqual(found, AdbDevice(serial="usb", android_id="android-1"))
        self.assertEqual([call[0] for call in fake.calls][0], ["adb-test", "-s", "usb", "shell", "settings", "get", "secure", "android_id"])
        self.assertTrue(all(call[1]["shell"] is False for call in fake.calls))

    def test_strict_registry_never_substitutes_another_serial_or_backend_identity(self):
        fake = FakeRun(); registry = AdbDeviceRegistry(run=fake, adb_path="adb-test", expected_serial="wifi", expected_android_id="android-1")
        registry.list_output = lambda: "List of devices attached\nusb\tdevice product:x\nwifi\tdevice product:x\n"
        self.assertEqual(registry.find("android-1"), AdbDevice(serial="wifi", android_id="android-1"))
        with self.assertRaises(PublisherError) as raised: registry.find("android-2")
        self.assertEqual(raised.exception.code, "DEVICE_IDENTITY_MISMATCH")
        self.assertTrue(all(call[0][2] == "wifi" for call in fake.calls))

    def test_legacy_backend_identity_maps_to_exact_physical_android_device(self):
        fake = FakeRun()
        registry = AdbDeviceRegistry(
            run=fake,
            adb_path="adb-test",
            expected_serial="wifi",
            expected_android_id="android-1",
            expected_backend_device_id="legacy-device-1",
        )
        registry.list_output = lambda: "List of devices attached\nwifi\tdevice product:x\n"
        self.assertEqual(registry.find("legacy-device-1"), AdbDevice(serial="wifi", android_id="android-1"))
        with self.assertRaises(PublisherError) as raised: registry.find("android-1")
        self.assertEqual(raised.exception.code, "DEVICE_IDENTITY_MISMATCH")

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


class MotioneventRun(FakeRun):
    """FakeRun whose no-arg `input` probe returns `usage`; support is
    "motionevent" in usage.  Probe invocations are counted separately and do
    not pollute the command log."""

    def __init__(self, usage): super().__init__(); self.usage, self.probes = usage, 0
    def __call__(self, argv, **kwargs):
        if argv[-2:] == ["shell", "input"]:
            self.probes += 1
            return subprocess.CompletedProcess(argv, 0, self.usage, "")
        return super().__call__(argv, **kwargs)


class AdbBezierTests(unittest.TestCase):
    def test_swipe_bezier_dispatches_sampled_motionevent_curve_with_cached_probe(self):
        usage = ("Usage: input [<source>] <command> [<arg>...]\n"
                 "The commands and default sources are:\n"
                 "    motionevent <DOWN|UP|MOVE|CANCEL> <x> <y>\n")
        fake = MotioneventRun(usage); pauses = []
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=pauses.append)
        with patch("southfarm_publisher.adb_device.random.random", return_value=0.5):
            adb.swipe_bezier(360, 350, 360, 1000, 400)
            adb.swipe_bezier(360, 350, 360, 1000, 400)
        self.assertEqual(fake.probes, 1, "motionevent support is probed once and cached")
        motions = [call[0][4:] for call in fake.calls if "motionevent" in call[0]]
        self.assertEqual(len(motions), 42, "two gestures of 1 DOWN + 19 MOVE + 1 UP")
        gesture = motions[:21]
        self.assertEqual(gesture[0], ["input", "motionevent", "DOWN", "360", "350"])
        self.assertEqual(gesture[-1], ["input", "motionevent", "UP", "360", "1000"])
        self.assertTrue(all(event[:2] == ["input", "motionevent"] for event in gesture))
        self.assertTrue(all(event[2] == "MOVE" for event in gesture[1:-1]))
        ys = [int(event[4]) for event in gesture]
        self.assertEqual(ys, sorted(ys), "a pull-to-refresh curve only travels downwards")
        self.assertEqual((ys[0], ys[-1]), (350, 1000), "the endpoints are exact")
        self.assertEqual({int(event[3]) for event in gesture}, {360}, "zero jitter keeps a vertical swipe straight")
        step = 0.4 / 19
        self.assertEqual(pauses, [step] * 40, "each gap is paced to duration/samples")

    def test_swipe_bezier_control_points_carry_the_service_x_jitter(self):
        usage = ("Usage: input [<source>] <command> [<arg>...]\n"
                 "    motionevent <DOWN|UP|MOVE|CANCEL> <x> <y>\n")
        fake = MotioneventRun(usage)
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=lambda seconds: None)
        with patch("southfarm_publisher.adb_device.random.random", side_effect=[0.0, 1.0]):
            adb.swipe_bezier(360, 350, 360, 1000, 400)
        motions = [call[0][4:] for call in fake.calls if "motionevent" in call[0]]
        xs = [int(event[3]) for event in motions]
        self.assertEqual((xs[0], xs[-1]), (360, 360), "endpoints stay exact")
        self.assertTrue(all(348 <= x <= 372 for x in xs), "the curve stays inside the +/-12 jitter envelope of the service")
        self.assertTrue(any(x != 360 for x in xs), "the jittered control points bend the sampled curve")

    def test_swipe_bezier_falls_back_to_straight_swipe_without_motionevent(self):
        fake = MotioneventRun("Usage: input [<source>] text|keyevent|tap|swipe\n")
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=lambda seconds: None)
        adb.swipe_bezier(360, 350, 360, 1000, 400)
        adb.swipe_bezier(100, 200, 300, 400, 250)
        self.assertEqual(fake.probes, 1, "the unsupported result is probed once and cached")
        swipes = [call[0] for call in fake.calls if "swipe" in call[0]]
        self.assertEqual(swipes, [
            ["adb-test", "-s", "serial-1", "shell", "input", "swipe", "360", "350", "360", "1000", "400"],
            ["adb-test", "-s", "serial-1", "shell", "input", "swipe", "100", "200", "300", "400", "250"],
        ])

    def test_swipe_bezier_probe_transport_error_reads_as_unsupported_fallback(self):
        class BrokenProbe(MotioneventRun):
            def __call__(self, argv, **kwargs):
                if argv[-2:] == ["shell", "input"]:
                    self.probes += 1
                    raise OSError("transport lost")
                return super().__call__(argv, **kwargs)
        fake = BrokenProbe("")
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=lambda seconds: None)
        adb.swipe_bezier(360, 350, 360, 1000, 400)
        self.assertEqual(fake.calls[-1][0], ["adb-test", "-s", "serial-1", "shell", "input", "swipe", "360", "350", "360", "1000", "400"])

    def test_swipe_bezier_rejects_invalid_coordinates_and_durations(self):
        adb = SafeAdb("serial-1", run=FakeRun(), adb_path="adb-test")
        with self.assertRaises(ValueError): adb.swipe_bezier(-1, 0, 10, 10, 300)
        with self.assertRaises(ValueError): adb.swipe_bezier(0, 0, 10001, 10, 300)
        with self.assertRaises(ValueError): adb.swipe_bezier(0, 0, 10, 10, 25)
        with self.assertRaises(ValueError): adb.swipe_bezier(0, 0, 10, 10, 3000)

    def test_dump_and_screenshot_use_bounded_argv_commands(self):
        class DeviceRun(FakeRun):
            def __call__(self, argv, **kwargs):
                self.calls.append((argv, kwargs))
                if argv[-3:] == ["uiautomator", "dump", "/dev/tty"]:
                    return subprocess.CompletedProcess(argv, 0, '<hierarchy><node text="Ready" bounds="[0,0][1,1]"/></hierarchy>', "")
                if argv[-3:] == ["screencap", "-p", "/dev/stdout"]:
                    return subprocess.CompletedProcess(argv, 0, b"PNG", b"")
                return subprocess.CompletedProcess(argv, 0, "", "")
        fake = DeviceRun(); adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", ui_source="uiautomator")
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

    def test_dump_ui_uses_accessibility_service_broadcast_and_retries_cat_until_fresh(self):
        xml = '<hierarchy><node text="Share" resource-id="share.id" bounds="[0,0][10,10]"/><node content-desc="Upload" resource-id="" bounds="[0,20][10,30]"/></hierarchy>'
        fake = ServiceDumpRun(xml, empty_cats=1); pauses = []
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=pauses.append)
        nodes = adb.dump_ui()
        self.assertEqual([nodes[0]["text"], nodes[1]["content-desc"]], ["Share", "Upload"])
        self.assertEqual([call[0][3:] for call in fake.calls], [
            ["shell", "rm", "-f", SafeAdb.SERVICE_DUMP_PATH],
            ["shell", "am", "broadcast", "-n", SafeAdb.SERVICE_DUMP_COMPONENT, "-a", SafeAdb.SERVICE_DUMP_ACTION],
            ["shell", "cat", SafeAdb.SERVICE_DUMP_PATH],
            ["shell", "cat", SafeAdb.SERVICE_DUMP_PATH],
        ])
        self.assertTrue(all(call[1]["timeout"] == SafeAdb.SERVICE_DUMP_COMMAND_TIMEOUT for call in fake.calls))
        self.assertEqual(pauses, [SafeAdb.SERVICE_DUMP_INITIAL_DELAY_SECONDS, SafeAdb.SERVICE_DUMP_POLL_SECONDS])

    def test_service_dump_poll_cat_race_is_tolerated_until_dump_lands(self):
        # The writer app lands the dump file ~0.9s after the broadcast; the
        # first `cat` exits rc=1 (no file) and must keep polling, not die.
        xml = '<hierarchy><node text="Share" resource-id="share.id" bounds="[0,0][10,10]"/></hierarchy>'
        class RacingCatRun:
            def __init__(self, xml): self.xml, self.calls, self.cats = xml, [], 0
            def __call__(self, argv, **kwargs):
                self.calls.append((argv, kwargs))
                if "rm" in argv or "broadcast" in argv: return subprocess.CompletedProcess(argv, 0, "", "")
                if "cat" in argv:
                    self.cats += 1
                    if self.cats == 1: return subprocess.CompletedProcess(argv, 1, "", "")
                    return subprocess.CompletedProcess(argv, 0, self.xml, "")
                return subprocess.CompletedProcess(argv, 0, "", "")
        fake = RacingCatRun(xml)
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=lambda seconds: None)
        nodes = adb.dump_ui()
        self.assertEqual(nodes[0]["text"], "Share")
        self.assertGreaterEqual(fake.cats, 2, "the failed first cat must be polled past, not fatal")

    def test_service_dump_all_cats_failing_ends_unavailable_at_deadline_not_command_failed(self):
        class AlwaysFailingCatRun:
            def __init__(self): self.calls, self.cats = [], 0
            def __call__(self, argv, **kwargs):
                self.calls.append((argv, kwargs))
                if "cat" in argv:
                    self.cats += 1
                    return subprocess.CompletedProcess(argv, 1, "", "")
                return subprocess.CompletedProcess(argv, 0, "", "")
        fake = AlwaysFailingCatRun()
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=lambda seconds: None)
        clock = iter([0.0, 1.0, 2.0, SafeAdb.SERVICE_DUMP_DEADLINE_SECONDS + 1.0])
        with patch("southfarm_publisher.adb_device.time") as fake_time:
            fake_time.monotonic = lambda: next(clock, SafeAdb.SERVICE_DUMP_DEADLINE_SECONDS + 1.0)
            fake_time.sleep = lambda seconds: None
            with self.assertRaises(PublisherError) as raised: adb.dump_ui()
        self.assertEqual(raised.exception.code, "UI_DUMP_UNAVAILABLE")
        self.assertTrue(raised.exception.retryable)
        self.assertGreaterEqual(fake.cats, 2, "polling must continue past failing cats until the deadline")

    def test_service_dump_ui_raises_retryable_unavailable_when_dump_never_appears(self):
        fake = ServiceDumpRun("<hierarchy/>", empty_cats=99)
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=lambda seconds: None)
        clock = iter([0.0, 1.0, 2.0, SafeAdb.SERVICE_DUMP_DEADLINE_SECONDS + 1.0])
        with patch("southfarm_publisher.adb_device.time") as fake_time:
            fake_time.monotonic = lambda: next(clock, SafeAdb.SERVICE_DUMP_DEADLINE_SECONDS + 1.0)
            fake_time.sleep = lambda seconds: None
            with self.assertRaises(PublisherError) as raised: adb.dump_ui()
        self.assertEqual(raised.exception.code, "UI_DUMP_UNAVAILABLE")
        self.assertTrue(raised.exception.retryable)
        self.assertGreaterEqual(fake.cats, 2, "polling must retry the cat before giving up")

    def test_service_dump_ui_accepts_dump_with_higher_seq(self):
        fake = SeqDumpRun('<hierarchy rotation="0" seq="1"><node text="Old" bounds="[0,0][1,1]"/></hierarchy>')
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=lambda seconds: None)
        self.assertEqual(adb.dump_ui()[0]["text"], "Old")
        self.assertEqual(adb._last_dump_seq, 1)
        fake.payloads = ['<hierarchy rotation="0" seq="2"><node text="New" bounds="[0,0][1,1]"/></hierarchy>']
        self.assertEqual(adb.dump_ui()[0]["text"], "New")
        self.assertEqual(adb._last_dump_seq, 2)
        self.assertEqual(sum("cat" in call[0] for call in fake.calls), 2, "higher seq must be accepted on the first cat")

    def test_service_dump_ui_polls_past_stale_seq_until_fresh_dump_lands(self):
        stale = '<hierarchy rotation="0" seq="1"><node text="Stale" bounds="[0,0][1,1]"/></hierarchy>'
        fresh = '<hierarchy rotation="0" seq="2"><node text="Fresh" bounds="[0,0][1,1]"/></hierarchy>'
        fake = SeqDumpRun(stale, fresh); pauses = []
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=pauses.append)
        self.assertEqual(adb.dump_ui()[0]["text"], "Stale")
        self.assertEqual(adb.dump_ui()[0]["text"], "Fresh")
        self.assertEqual(pauses, [SafeAdb.SERVICE_DUMP_INITIAL_DELAY_SECONDS, SafeAdb.SERVICE_DUMP_INITIAL_DELAY_SECONDS, SafeAdb.SERVICE_DUMP_POLL_SECONDS], "stale seq must keep polling instead of being served")
        self.assertEqual(adb._last_dump_seq, 2)

    def test_service_dump_ui_accepts_unsequenced_xml_from_older_app(self):
        fake = SeqDumpRun('<hierarchy rotation="0" seq="7"><node text="Sequenced" bounds="[0,0][1,1]"/></hierarchy>')
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=lambda seconds: None)
        adb.dump_ui()
        fake.payloads = ['<hierarchy rotation="0"><node text="Legacy" bounds="[0,0][1,1]"/></hierarchy>']
        self.assertEqual(adb.dump_ui()[0]["text"], "Legacy")
        self.assertEqual(sum("cat" in call[0] for call in fake.calls), 2, "xml without seq must be accepted on the first cat")

    def test_service_dump_ui_serves_newest_stale_tree_at_deadline(self):
        stale = '<hierarchy rotation="0" seq="5"><node text="Stale" bounds="[0,0][1,1]"/></hierarchy>'
        fake = SeqDumpRun(stale)
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=lambda seconds: None)
        adb.dump_ui()
        cats_before = fake.cats
        clock = iter([0.0, 1.0, 2.0, SafeAdb.SERVICE_DUMP_DEADLINE_SECONDS + 1.0])
        with patch("southfarm_publisher.adb_device.time") as fake_time:
            fake_time.monotonic = lambda: next(clock, SafeAdb.SERVICE_DUMP_DEADLINE_SECONDS + 1.0)
            fake_time.sleep = lambda seconds: None
            self.assertEqual(adb.dump_ui()[0]["text"], "Stale")
        self.assertGreaterEqual(fake.cats - cats_before, 2, "deadline must be reached by polling, not by failing fast")
        self.assertEqual(adb._last_dump_seq, 5)

    def test_service_dump_ui_raises_unavailable_when_fresh_dump_never_lands(self):
        fake = SeqDumpRun('<hierarchy rotation="0" seq="3"><node text="Earlier" bounds="[0,0][1,1]"/></hierarchy>')
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=lambda seconds: None)
        adb.dump_ui()
        cats_before = fake.cats
        fake.payloads = [""]
        clock = iter([0.0, 1.0, 2.0, SafeAdb.SERVICE_DUMP_DEADLINE_SECONDS + 1.0])
        with patch("southfarm_publisher.adb_device.time") as fake_time:
            fake_time.monotonic = lambda: next(clock, SafeAdb.SERVICE_DUMP_DEADLINE_SECONDS + 1.0)
            fake_time.sleep = lambda seconds: None
            with self.assertRaises(PublisherError) as raised: adb.dump_ui()
        self.assertEqual(raised.exception.code, "UI_DUMP_UNAVAILABLE")
        self.assertTrue(raised.exception.retryable)
        self.assertGreaterEqual(fake.cats - cats_before, 2, "polling must retry the cat before giving up")

    def test_explicit_uiautomator_dump_forces_uiautomator_even_under_service_default(self):
        class DeviceRun(FakeRun):
            def __call__(self, argv, **kwargs):
                self.calls.append((argv, kwargs))
                if argv[-3:] == ["uiautomator", "dump", "/dev/tty"]:
                    return subprocess.CompletedProcess(argv, 0, '<hierarchy><node text="Add details" resource-id="com.google.android.youtube:id/upload_bottom_button" bounds="[0,0][1,1]"/></hierarchy>', "")
                if "cat" in argv:
                    return subprocess.CompletedProcess(argv, 0, '<hierarchy><node text="Protected" bounds="[0,0][1,1]"/></hierarchy>', "")
                return subprocess.CompletedProcess(argv, 0, "", "")
        fake = DeviceRun(); adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", ui_source="service", pause=lambda seconds: None)
        adb.dump_ui()  # default service dump: never invokes uiautomator
        self.assertEqual(sum("uiautomator" in call[0] for call in fake.calls), 0)
        nodes = adb.dump_ui_explicit("uiautomator")  # one-off explicit dump
        self.assertEqual(nodes[0]["resource-id"], "com.google.android.youtube:id/upload_bottom_button")
        self.assertEqual(fake.calls[-1][0], ["adb-test", "-s", "serial-1", "exec-out", "uiautomator", "dump", "/dev/tty"])
        with self.assertRaises(PublisherError) as raised: adb.dump_ui_explicit("screenreader")
        self.assertEqual(raised.exception.code, "CONFIG_INVALID")

    def test_invalid_ui_source_is_rejected_as_config_error(self):
        with self.assertRaises(PublisherError) as raised:
            SafeAdb("serial-1", run=FakeRun(), adb_path="adb-test", ui_source="screenreader")
        self.assertEqual(raised.exception.code, "CONFIG_INVALID")

    def test_registry_open_forwards_ui_source_to_safe_adb(self):
        registry = AdbDeviceRegistry(run=FakeRun(), adb_path="adb-test", expected_serial="wifi", expected_android_id="android-1", ui_source="uiautomator")
        registry.list_output = lambda: "List of devices attached\nwifi\tdevice product:x\n"
        opened = registry.open("android-1")
        self.assertEqual(opened.ui_source, "uiautomator")
        self.assertEqual(opened.SERVICE_DUMP_PATH, "/sdcard/Android/data/com.example.southfarm_app/files/southfarm_ui.xml")

    def test_text_adb_commands_decode_utf8_xml_on_windows(self):
        fake = FakeRun()
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test")
        adb.command("exec-out", "uiautomator", "dump", "/dev/tty")
        kwargs = fake.calls[-1][1]
        self.assertEqual(kwargs["encoding"], "utf-8")
        self.assertEqual(kwargs["errors"], "replace")

    def test_parse_ui_ignores_uiautomator_dump_status_suffix(self):
        xml = '<?xml version="1.0" encoding="UTF-8" ?><hierarchy><node text="Instagram" /></hierarchy>'
        nodes = SafeAdb.parse_ui(xml + "UI hierchary dumped to: /dev/tty\n")
        self.assertEqual(nodes[0]["text"], "Instagram")

    def test_parse_ui_collapses_exact_duplicate_nodes(self):
        node = '<node text="Like" resource-id="com.instagram.android:id/like" class="android.widget.ImageView" bounds="[0,0][50,50]"/>'
        nodes = SafeAdb.parse_ui(f'<hierarchy>{node}{node}{node}</hierarchy>')
        self.assertEqual(len(nodes), 1)
        self.assertEqual(nodes[0]["resource-id"], "com.instagram.android:id/like")

    def test_parse_ui_keeps_distinct_nodes_with_equal_partial_attributes(self):
        xml = ('<hierarchy>'
               '<node text="Like" resource-id="com.instagram.android:id/action" class="android.widget.ImageView" bounds="[0,0][50,50]"/>'
               '<node text="Comment" resource-id="com.instagram.android:id/action" class="android.widget.ImageView" bounds="[0,0][50,50]"/>'
               '</hierarchy>')
        nodes = SafeAdb.parse_ui(xml)
        self.assertEqual([node["text"] for node in nodes], ["Like", "Comment"])

    def test_remote_path_is_sanitized(self):
        self.assertEqual(SafeAdb.safe_remote_name("../../clip name.mp4"), "clip_name.mp4")
        with self.assertRaises(ValueError): SafeAdb.safe_remote_name("..").__str__()
    def test_text_and_remote_operations_reject_unsafe_inputs(self):
        adb = SafeAdb("serial-1", run=FakeRun(), adb_path="adb-test")
        with self.assertRaises(ValueError): adb.text("unsafe; rm")
        with self.assertRaises(ValueError): adb.remove("/sdcard/Download/clip.mp4")


class RevivableServiceRun:
    """Scripted adb run for the accessibility health pre-flight.

    The service dump is dead (empty cats) until either the fake starts alive
    or the repair's force-stop lands (simulating the rebind), after which
    cats serve a fresh sequenced dump.  Every command advances the shared
    clock by 0.5s so dump-poll deadlines are reached without real waiting;
    SafeAdb's `pause` is injected as a no-op.
    """

    def __init__(self, *, alive: bool, services_value: str, revive_on_repair: bool):
        self.revived = alive
        self.services_value = services_value
        self.revive_on_repair = revive_on_repair
        self.calls = []
        self.clock = {"now": 0.0}

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        self.clock["now"] += 0.5
        if "settings" in argv and "get" in argv:
            return subprocess.CompletedProcess(argv, 0, self.services_value, "")
        if "force-stop" in argv:
            if self.revive_on_repair:
                self.revived = True
            return subprocess.CompletedProcess(argv, 0, "", "")
        if "settings" in argv and "put" in argv:
            return subprocess.CompletedProcess(argv, 0, "", "")
        if "cat" in argv:
            if self.revived:
                return subprocess.CompletedProcess(argv, 0, '<hierarchy rotation="0" seq="7"><node text="Alive" bounds="[0,0][1,1]"/></hierarchy>', "")
            return subprocess.CompletedProcess(argv, 0, "", "")
        return subprocess.CompletedProcess(argv, 0, "", "")


class AccessibilityHealthTests(unittest.TestCase):
    def with_clock(self, fake):
        patcher = patch("southfarm_publisher.adb_device.time")
        fake_time = patcher.start()
        fake_time.monotonic = lambda: fake.clock["now"]
        self.addCleanup(patcher.stop)
        return fake

    def test_ensure_accessibility_healthy_accepts_live_service_without_repair(self):
        fake = RevivableServiceRun(alive=True, services_value="com.other.app/.OtherService\n", revive_on_repair=True)
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=lambda seconds: None)
        self.with_clock(fake)
        adb.ensure_accessibility_healthy()
        self.assertFalse(any("force-stop" in call[0] or "settings" in call[0] for call in fake.calls), "a live service must never be repaired")
        self.assertEqual(fake.calls[0][0][3:], ["shell", "rm", "-f", SafeAdb.SERVICE_DUMP_PATH])
        self.assertEqual(fake.calls[1][0][3:], ["shell", "am", "broadcast", "-n", SafeAdb.SERVICE_DUMP_COMPONENT, "-a", SafeAdb.SERVICE_DUMP_ACTION])

    def test_ensure_accessibility_healthy_skips_non_service_ui_source(self):
        fake = RevivableServiceRun(alive=True, services_value="", revive_on_repair=True)
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", ui_source="uiautomator", pause=lambda seconds: None)
        adb.ensure_accessibility_healthy()
        self.assertEqual(fake.calls, [], "uiautomator-only jobs never depend on the service")

    def test_ensure_accessibility_healthy_repairs_crashed_service_and_continues(self):
        preserved = "com.other.app/.OtherService:com.example.southfarm_app/com.example.southfarm_app.SouthFarmAccessibilityService"
        fake = RevivableServiceRun(alive=False, services_value=f"{preserved}\n", revive_on_repair=True)
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=lambda seconds: None)
        self.with_clock(fake)
        adb.ensure_accessibility_healthy()  # dead -> repaired -> re-verified: no raise
        read = next(i for i, (argv, _) in enumerate(fake.calls) if "settings" in argv and "get" in argv)
        stop = next(i for i, (argv, _) in enumerate(fake.calls) if "force-stop" in argv)
        puts = [i for i, (argv, _) in enumerate(fake.calls) if "settings" in argv and "put" in argv]
        self.assertTrue(read < stop < puts[0], "the repair reads the current value, force-stops, then re-sets the settings")
        self.assertEqual(fake.calls[stop][0][-1], SafeAdb.SERVICE_PACKAGE)
        self.assertEqual(fake.calls[puts[0]][0], ["adb-test", "-s", "serial-1", "shell", "settings", "put", "secure", "enabled_accessibility_services", preserved], "the existing value is re-written identically, preserving every other service")
        self.assertEqual(fake.calls[puts[1]][0], ["adb-test", "-s", "serial-1", "shell", "settings", "put", "secure", "accessibility_enabled", "1"])
        self.assertGreaterEqual(sum("cat" in argv and i < stop for i, (argv, _) in enumerate(fake.calls)), 2, "the dead service was polled past before repairing")

    def test_ensure_accessibility_healthy_repair_appends_service_when_missing(self):
        fake = RevivableServiceRun(alive=False, services_value="com.other.app/.OtherService\n", revive_on_repair=True)
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=lambda seconds: None)
        self.with_clock(fake)
        adb.ensure_accessibility_healthy()
        put = next(call[0] for call in fake.calls if "settings" in call[0] and "put" in call[0])
        self.assertEqual(put[-1], f"com.other.app/.OtherService:{SafeAdb.SERVICE_FLAT_COMPONENT}", "our component is appended in canonical form, existing services preserved")

    def test_ensure_accessibility_healthy_repair_writes_canonical_component_when_setting_nulled(self):
        # HyperOS nulls enabled_accessibility_services after failed binds:
        # the repair must write the explicit canonical component, never a
        # verbatim re-write of the read value.
        for value in ("null\n", "\n"):
            with self.subTest(value=value):
                fake = RevivableServiceRun(alive=False, services_value=value, revive_on_repair=True)
                adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=lambda seconds: None)
                self.with_clock(fake)
                adb.ensure_accessibility_healthy()
                put = next(call[0] for call in fake.calls if "settings" in call[0] and "put" in call[0] and "enabled_accessibility_services" in call[0])
                self.assertEqual(put[-1], SafeAdb.SERVICE_FLAT_COMPONENT, "the nulled setting is re-written as the explicit canonical component")

    def test_ensure_accessibility_healthy_repair_canonicalizes_our_component_among_preserved_services(self):
        shorthand = "com.other.app/.OtherService:com.example.southfarm_app/.SouthFarmAccessibilityService"
        fake = RevivableServiceRun(alive=False, services_value=f"{shorthand}\n", revive_on_repair=True)
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=lambda seconds: None)
        self.with_clock(fake)
        adb.ensure_accessibility_healthy()
        put = next(call[0] for call in fake.calls if "settings" in call[0] and "put" in call[0] and "enabled_accessibility_services" in call[0])
        self.assertEqual(put[-1], f"com.other.app/.OtherService:{SafeAdb.SERVICE_FLAT_COMPONENT}", "other services are preserved verbatim while ours is written canonically")

    def test_ensure_accessibility_healthy_repair_grace_precedes_first_post_repair_dump(self):
        # The 2026-08-17 live lesson: dump broadcasts during the rebind
        # interfere with it.  After the settings re-set the repair must
        # sleep the full grace window WITHOUT any dump command, and only
        # then resume fresh-dump verification.
        self.assertEqual(SafeAdb.SERVICE_REBIND_GRACE_SECONDS, 6.0)
        fake = RevivableServiceRun(alive=False, services_value="null\n", revive_on_repair=True)
        events = []

        def run(argv, **kwargs):
            events.append(("call", argv))
            return fake(argv, **kwargs)

        def pause(seconds):
            events.append(("pause", seconds))

        adb = SafeAdb("serial-1", run=run, adb_path="adb-test", pause=pause)
        self.with_clock(fake)
        adb.ensure_accessibility_healthy()
        put = max(i for i, (kind, argv) in enumerate(events) if kind == "call" and "settings" in argv and "put" in argv)
        self.assertEqual(events[put + 1], ("pause", SafeAdb.SERVICE_REBIND_GRACE_SECONDS), "the grace sleep is the immediate next event after the settings re-set")
        rest = events[put + 2:]
        dumps = [argv for kind, argv in rest if kind == "call" and ("cat" in argv or "rm" in argv or "broadcast" in argv)]
        self.assertTrue(dumps, "fresh-dump verification resumes after the grace window")
        self.assertEqual(dumps[0][3:], ["shell", "rm", "-f", SafeAdb.SERVICE_DUMP_PATH], "the first post-repair dump request starts only after the grace")

    def test_ensure_accessibility_healthy_aborts_when_service_stays_dead_after_repair(self):
        fake = RevivableServiceRun(alive=False, services_value="com.other.app/.OtherService\n", revive_on_repair=False)
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test", pause=lambda seconds: None)
        self.with_clock(fake)
        with self.assertRaises(PublisherError) as raised:
            adb.ensure_accessibility_healthy()
        self.assertEqual(raised.exception.code, "ACCESSIBILITY_SERVICE_DOWN")
        self.assertTrue(raised.exception.retryable)
        self.assertTrue(any("force-stop" in call[0] for call in fake.calls), "the repair was attempted before giving up")
        self.assertTrue(any("settings" in call[0] and "put" in call[0] for call in fake.calls), "the settings re-set ran before the abort")


class NetworkRun:
    """Scripted adb run for the connectivity pre-flight.

    ping responses are fixed (rc + output); every `dumpsys connectivity`
    invocation returns the scripted connectivity output.
    """

    def __init__(self, ping_rc=0, ping_out="", connectivity_out=""):
        self.ping_rc, self.ping_out, self.connectivity_out = ping_rc, ping_out, connectivity_out
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        if "ping" in argv:
            return subprocess.CompletedProcess(argv, self.ping_rc, self.ping_out, "")
        if "connectivity" in argv:
            return subprocess.CompletedProcess(argv, 0, self.connectivity_out, "")
        return subprocess.CompletedProcess(argv, 0, "", "")


VALIDATED_DUMPSYS = (
    "Active default network: WIFI (wlan0)\n"
    "NetworkAgentInfo{... WIFI ...}:\n"
    "  ConnectivityState: CONNECTED/VALIDATED\n"
)


class NetworkPreflightTests(unittest.TestCase):
    def test_ensure_network_up_accepts_answered_ping_without_dumpsys_fallback(self):
        fake = NetworkRun(ping_rc=0)
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test")
        adb.ensure_network_up()
        ping = [call for call in fake.calls if "ping" in call[0]]
        self.assertEqual(ping[0][0], ["adb-test", "-s", "serial-1", "shell", "ping", "-c", "2", "-W", "2", "8.8.8.8"])
        self.assertFalse(any("connectivity" in call[0] for call in fake.calls), "an answered ping never consults dumpsys")

    def test_ensure_network_up_falls_back_to_validated_dumpsys_when_ping_fails(self):
        # ping gets no echo reply (ICMP blocked or ping unavailable) but
        # dumpsys proves an active validated network: the device is up.
        fake = NetworkRun(ping_rc=1, ping_out="2 packets transmitted, 0 received\n", connectivity_out=VALIDATED_DUMPSYS)
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test")
        adb.ensure_network_up()  # must not raise
        self.assertTrue(any("connectivity" in call[0] for call in fake.calls), "the failed ping falls back to dumpsys")

    def test_ensure_network_up_treats_ping_transport_error_as_unproven(self):
        class BrokenPingRun(NetworkRun):
            def __call__(self, argv, **kwargs):
                if "ping" in argv:
                    raise OSError("transport lost")
                return super().__call__(argv, **kwargs)
        fake = BrokenPingRun(connectivity_out=VALIDATED_DUMPSYS)
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test")
        adb.ensure_network_up()  # transport failure reads as "not proven", not fatal
        self.assertTrue(any("connectivity" in call[0] for call in fake.calls))

    def test_ensure_network_up_aborts_device_offline_when_neither_probe_confirms(self):
        for connectivity_out in ("Active default network: none\n", "Active default network: null\n", ""):
            with self.subTest(connectivity_out=connectivity_out):
                fake = NetworkRun(ping_rc=1, ping_out="2 packets transmitted, 0 received\n", connectivity_out=connectivity_out)
                adb = SafeAdb("serial-1", run=fake, adb_path="adb-test")
                with self.assertRaises(PublisherError) as raised:
                    adb.ensure_network_up()
                self.assertEqual(raised.exception.code, "DEVICE_OFFLINE")
                self.assertTrue(raised.exception.retryable)
                self.assertTrue(any("connectivity" in call[0] for call in fake.calls), "the dumpsys fallback ran before the abort")

    def test_ensure_network_up_rejects_connected_but_unvalidated_default_network(self):
        # A default network that never reaches VALIDATED (captive portal or
        # no route) is not a usable link: both probes must confirm.
        fake = NetworkRun(ping_rc=1, connectivity_out="Active default network: WIFI (wlan0)\n  ConnectivityState: CONNECTED/CONNECTED\n")
        adb = SafeAdb("serial-1", run=fake, adb_path="adb-test")
        with self.assertRaises(PublisherError) as raised:
            adb.ensure_network_up()
        self.assertEqual(raised.exception.code, "DEVICE_OFFLINE")
