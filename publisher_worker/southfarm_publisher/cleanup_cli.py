from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Callable

from .adb_device import AdbDeviceRegistry, DEFAULT_ADB
from .api_client import PublisherApiClient
from .models import PublisherError
from .platforms import InstagramPublisher, TikTokPublisher, YouTubeShortPublisher

TEST_MARKER = "SOUTHFARM_AUTHORIZED_TEST_POST"
PACKAGES = {"instagram": "com.instagram.android", "tiktok": "com.zhiliaoapp.musically", "youtube": "com.google.android.youtube"}


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise PublisherError("CLEANUP_ARGS_INVALID", "Cleanup arguments are incomplete or invalid")


def _arguments(argv: list[str]) -> argparse.Namespace:
    parser = _Parser(prog="southfarm-test-cleanup", add_help=False)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--platform", choices=tuple(PACKAGES), required=True)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--android-id", required=True)
    parser.add_argument("--account", required=True)
    parser.add_argument("--adb", default=DEFAULT_ADB)
    parser.add_argument("--api-url")
    parser.add_argument("--worker-token")
    parser.add_argument("--worker-id")
    parser.add_argument("--apply", action="store_true")
    try:
        return parser.parse_args(argv)
    except SystemExit as error:
        raise PublisherError("CLEANUP_ARGS_INVALID", "Cleanup arguments are incomplete or invalid") from error


def _load_manifest(path: str) -> dict[str, Any]:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError) as error:
        raise PublisherError("CLEANUP_MANIFEST_INVALID", "Cleanup manifest is unavailable or invalid") from error
    required = {"schema", "marker", "authorization", "job_id", "job_status", "platform", "serial", "android_id", "account", "expected_identity", "baseline", "test_mode"}
    if type(value) is not dict or set(value) != required:
        raise PublisherError("CLEANUP_MANIFEST_INVALID", "Cleanup manifest schema is invalid")
    strings = ("authorization", "platform", "serial", "android_id", "account", "expected_identity")
    baseline = value.get("baseline")
    if value.get("schema") != 1 or value.get("marker") != TEST_MARKER or value.get("test_mode") is not True or type(value.get("job_id")) is not int or value["job_id"] <= 0 or value.get("job_status") != "completed" or any(type(value.get(key)) is not str or not value[key].strip() for key in strings) or value["platform"] not in PACKAGES or type(baseline) is not list or not baseline or any(type(item) is not str or not item for item in baseline) or value["expected_identity"] in baseline:
        raise PublisherError("CLEANUP_MANIFEST_INVALID", "Cleanup manifest does not prove an eligible completed test post")
    return value


def _adapter(platform: str, account: str) -> Any:
    classes = {"instagram": InstagramPublisher, "tiktok": TikTokPublisher, "youtube": YouTubeShortPublisher}
    return classes[platform](expected_account=account)


def execute_cleanup(argv: list[str], *, registry_factory: Callable[..., Any] = AdbDeviceRegistry, adapter_factory: Callable[[str, str], Any] = _adapter, authorization_client: Any | None = None, emit: Callable[[dict[str, Any]], None] = print) -> dict[str, Any]:
    args = _arguments(argv)
    manifest = _load_manifest(args.manifest)
    supplied = {"platform": args.platform, "serial": args.serial, "android_id": args.android_id, "account": args.account}
    if any(manifest[key] != value for key, value in supplied.items()):
        raise PublisherError("CLEANUP_PROVENANCE_MISMATCH", "Explicit cleanup identity does not match test provenance")
    if authorization_client is None:
        if not args.api_url or not args.worker_token or not args.worker_id:
            raise PublisherError("CLEANUP_AUTHORIZATION_REQUIRED", "Cleanup requires a live backend authorization client")
        authorization_client = PublisherApiClient(args.api_url, args.worker_token, args.worker_id)
    authorized = authorization_client.validate_cleanup_authorization(manifest["authorization"])
    if not isinstance(authorized, dict) or any(authorized.get(key) != manifest[key] for key in manifest if key != "authorization"):
        raise PublisherError("CLEANUP_PROVENANCE_MISMATCH", "Backend authorization does not match cleanup provenance")
    registry = registry_factory(adb_path=args.adb, expected_serial=args.serial, expected_android_id=args.android_id)
    device = registry.open(args.android_id)
    adapter = adapter_factory(args.platform, args.account)
    if getattr(adapter, "package", None) != PACKAGES[args.platform]:
        raise PublisherError("CLEANUP_PLATFORM_MISMATCH", "Cleanup adapter package does not match platform")
    adapter._cleanup_preflight(manifest["expected_identity"], manifest["baseline"], device)
    result = {"status": "validated", "job_id": manifest["job_id"], "platform": args.platform, "applied": False}
    if args.apply:
        consumed = authorization_client.consume_cleanup_authorization(manifest["authorization"])
        if not isinstance(consumed, dict) or any(consumed.get(key) != manifest[key] for key in manifest if key != "authorization"):
            raise PublisherError("CLEANUP_AUTHORIZATION_INVALID", "Backend cleanup authorization could not be consumed")
        adapter.cleanup_test_post(manifest["expected_identity"], manifest["baseline"], device)
        result.update(status="deleted", applied=True)
    emit(result)
    return result


def main() -> None:
    import sys
    try:
        execute_cleanup(sys.argv[1:])
    except PublisherError as error:
        print(json.dumps({"status": "rejected", "code": error.code}))
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
