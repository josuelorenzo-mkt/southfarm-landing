import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from southfarm_publisher.cleanup_cli import execute_cleanup
from southfarm_publisher.models import PublisherError


class Device:
    def __init__(self, package, nodes): self.package, self.nodes, self.taps = package, nodes, []
    def foreground_package(self): return self.package
    def dump_ui(self): return self.nodes
    def tap_bounds(self, bounds, delay_seconds=0): self.taps.append(bounds)


class Registry:
    def __init__(self, device): self.device, self.opens = device, []
    def open(self, android_id): self.opens.append(android_id); return self.device


class Adapter:
    package = "com.instagram.android"
    def __init__(self): self.expected_account, self.cleaned = "safe.account", []
    def _cleanup_preflight(self, expected, baseline, device):
        values = [n.get("text") or n.get("content-desc") for n in device.dump_ui()]
        if values != [baseline[0], expected, *baseline[1:]]: raise PublisherError("CLEANUP_IDENTITY_MISMATCH", "ambiguous")
        return device.dump_ui()
    def cleanup_test_post(self, expected, baseline, device): self._cleanup_preflight(expected, baseline, device); self.cleaned.append((expected, baseline))


class AuthorizationClient:
    def __init__(self, authorization): self.authorization, self.calls = authorization, []
    def validate_cleanup_authorization(self, authorization, device_id):
        self.calls.append(("validate", authorization, device_id)); return self.authorization
    def consume_cleanup_authorization(self, authorization, device_id):
        self.calls.append(("consume", authorization, device_id)); return self.authorization


def manifest(**overrides):
    value = {"schema": 1, "marker": "SOUTHFARM_AUTHORIZED_TEST_POST", "authorization": "signed-server-token", "job_id": 7, "job_status": "completed", "platform": "instagram", "serial": "USB-1", "android_id": "android-1", "account": "safe.account", "expected_identity": "new reel", "baseline": ["safe.account", "old reel"], "test_mode": True}
    value.update(overrides); return value


class CleanupCliTests(unittest.TestCase):
    def invoke(self, value, args, *, nodes=None, authorized=None):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manifest.json"; path.write_text(json.dumps(value), encoding="utf-8")
            adapter = Adapter(); device = Device("com.instagram.android", nodes or [{"text": "safe.account"}, {"content-desc": "new reel"}, {"content-desc": "old reel"}]); registry = Registry(device); output = []
            client = AuthorizationClient(authorized or value)
            result = execute_cleanup(["--manifest", str(path), "--platform", "instagram", "--serial", "USB-1", "--android-id", "android-1", "--account", "safe.account", "--device-id", "42", *args], registry_factory=lambda **kwargs: registry, adapter_factory=lambda platform, account: adapter, authorization_client=client, emit=output.append)
            return result, adapter, device, registry, output, client

    def test_no_arguments_rejected(self):
        with self.assertRaises(PublisherError) as raised: execute_cleanup([])
        self.assertEqual(raised.exception.code, "CLEANUP_ARGS_INVALID")

    def test_dry_run_is_default_and_never_deletes(self):
        result, adapter, device, registry, output, client = self.invoke(manifest(), [])
        self.assertEqual(result["status"], "validated")
        self.assertEqual(adapter.cleaned, []); self.assertEqual(device.taps, [])
        self.assertNotIn("safe.account", json.dumps(output)); self.assertNotIn("new reel", json.dumps(output))
        self.assertEqual(client.calls, [("validate", "signed-server-token", 42)])

    def test_forged_local_manifest_is_rejected_before_adb(self):
        signed = manifest()
        forged = manifest(account="attacker.account")
        with self.assertRaises(PublisherError) as raised:
            self.invoke(forged, [], authorized=signed)
        self.assertEqual(raised.exception.code, "CLEANUP_PROVENANCE_MISMATCH")

    def test_account_or_device_mismatch_rejected_before_open(self):
        for changed in ({"account": "other"}, {"serial": "OTHER"}, {"android_id": "other"}):
            with self.subTest(changed=changed), self.assertRaises(PublisherError) as raised:
                self.invoke(manifest(**changed), [])
            self.assertEqual(raised.exception.code, "CLEANUP_PROVENANCE_MISMATCH")

    def test_non_test_review_required_or_ambiguous_manifest_rejected(self):
        cases = [manifest(test_mode=False), manifest(marker="wrong"), manifest(job_status="review_required"), manifest(baseline=[]), manifest(expected_identity="old reel")]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(PublisherError): self.invoke(value, [])

    def test_stale_missing_or_multiple_identity_rejected(self):
        cases = [
            [{"text": "safe.account"}, {"content-desc": "old reel"}],
            [{"text": "safe.account"}, {"content-desc": "new reel"}, {"content-desc": "new reel"}, {"content-desc": "old reel"}],
        ]
        for nodes in cases:
            with self.subTest(nodes=nodes), self.assertRaises(PublisherError) as raised: self.invoke(manifest(), [], nodes=nodes)
            self.assertEqual(raised.exception.code, "CLEANUP_IDENTITY_MISMATCH")

    def test_apply_calls_explicit_cleanup_and_requires_restoration(self):
        result, adapter, _, registry, _, client = self.invoke(manifest(), ["--apply"])
        self.assertEqual(result["status"], "deleted")
        self.assertEqual(adapter.cleaned, [("new reel", ["safe.account", "old reel"])])
        self.assertEqual(registry.opens, ["android-1"])
        self.assertEqual(client.calls, [("validate", "signed-server-token", 42), ("consume", "signed-server-token", 42)])


if __name__ == "__main__": unittest.main()
