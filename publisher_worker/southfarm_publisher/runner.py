from __future__ import annotations

import os
import random
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .adb_device import AdbDeviceRegistry, DEFAULT_ADB, SafeAdb
from .api_client import PublisherApiClient
from .models import JobCancelled, PublisherError

ORDER = ("preparing", "transferring", "selecting_media", "editing", "captioning", "ready_to_publish", "publishing", "verifying")
MIME_EXTENSIONS = {"video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm"}

class PublicationRunner:
    def __init__(self, api: Any, registry: Any, adapters: dict[str, Any], *, temp_dir: str | None = None, heartbeat_interval: float = 20.0):
        if not adapters: raise PublisherError("CONFIG_ADAPTERS_EMPTY", "No publisher adapters are configured")
        self.api, self.registry, self.adapters = api, registry, adapters; self.temp_dir = temp_dir; self.heartbeat_interval = min(max(1.0, heartbeat_interval), 44.0)
    @staticmethod
    def backoff_seconds(random_value=random.random) -> float: return min(30.0, max(2.0, 2.0 + float(random_value()) * 28.0))
    def _heartbeat_once(self, job_id: int, claim_token: str) -> None:
        if self.api.heartbeat(job_id, claim_token).get("cancel_requested"): raise JobCancelled()
    def _available_identity(self, availability: dict[str, Any], job_id: int) -> str:
        device = availability.get("device") or {}; lock = availability.get("publication_lock") or {}; reasons = set(availability.get("reasons") or [])
        own_lock = lock.get("publication_job_id") == job_id and lock.get("worker_id") == self.api.worker_id
        allowed = {"device_busy_publication"} if own_lock else set()
        identity = device.get("device_id")
        if not availability.get("online") or reasons - allowed or not own_lock or not isinstance(identity, str) or not identity:
            raise PublisherError("DEVICE_UNAVAILABLE", "The assigned device is not available", retryable=True)
        return identity
    @staticmethod
    def _media_extension(media: dict[str, Any]) -> str:
        mime, extension = media.get("mime_type"), media.get("file_extension")
        if mime not in MIME_EXTENSIONS or extension != MIME_EXTENSIONS[mime] or not isinstance(media.get("size_bytes"), int) or media["size_bytes"] <= 0 or not isinstance(media.get("sha256"), str) or len(media["sha256"]) != 64:
            raise PublisherError("MEDIA_METADATA_INVALID", "Publication media metadata is invalid")
        return extension
    def run_once(self, device_id: int) -> bool:
        claim = self.api.claim(device_id)
        if not claim: return False
        job, token, adapter_source = claim.job, claim.claim_token, self.adapters.get(claim.job.platform)
        adapter = adapter_source(job) if callable(adapter_source) else adapter_source
        state = {"final_intent": False, "final_persisted": False, "terminal_attempted": False, "index": -1}; stop = threading.Event(); heartbeat_error: list[Exception] = []; device = None; remote_path = None
        def heartbeat_loop():
            while not stop.wait(self.heartbeat_interval):
                try: self._heartbeat_once(job.id, token)
                except Exception as error: heartbeat_error.append(error); stop.set()
        thread = threading.Thread(target=heartbeat_loop, name=f"southfarm-publisher-heartbeat-{job.id}"); thread.start()
        heartbeat_stopped = False
        def stop_heartbeat() -> None:
            nonlocal heartbeat_stopped
            if heartbeat_stopped: return
            stop.set()
            if threading.current_thread() is not thread: thread.join()
            heartbeat_stopped = True
        def terminal_finish(status: str, **metadata: Any) -> None:
            if state["terminal_attempted"]: return
            state["terminal_attempted"] = True
            stop_heartbeat()
            self.api.finish(job.id, token, status, **metadata)
        try:
            if adapter is None: raise PublisherError("CONFIG_ADAPTER_MISSING", "No publisher adapter is configured")
            identity = self._available_identity(self.api.availability(job.device_id), job.id); device = self.registry.open(identity); self._heartbeat_once(job.id, token)
            extension = self._media_extension(job.media)
            with tempfile.TemporaryDirectory(dir=self.temp_dir) as directory:
                local_path = Path(directory) / SafeAdb.safe_remote_name(f"publication-{job.id}-{job.media_id}.{extension}")
                self.api.download_media(job.media_id, token, local_path, job.media)
                remote_path = f"/sdcard/Movies/SouthFarm/{SafeAdb.safe_remote_name(local_path.name)}"
                def checkpoint(step: str, progress: int, final_action: bool = False, evidence: Any = None):
                    if step not in ORDER or ORDER.index(step) < state["index"] or (step == "publishing") != final_action: raise PublisherError("CHECKPOINT_ORDER_INVALID", "Publication checkpoint is invalid")
                    if heartbeat_error: raise heartbeat_error[0]
                    self._heartbeat_once(job.id, token)
                    if final_action: state["final_intent"] = True
                    self.api.checkpoint(job.id, token, step, progress, final_action=final_action, evidence=evidence)
                    state["index"] = ORDER.index(step)
                    if final_action: state["final_persisted"] = True
                checkpoint("preparing", 1); adapter.prepare(job, device)
                checkpoint("transferring", 5); device.push(str(local_path), remote_path); device.scan_media(remote_path)
                adapter.publish(job, device, checkpoint)
                if not state["final_persisted"]: raise PublisherError("FINAL_ACTION_MISSING", "Adapter did not checkpoint final publishing action")
                checkpoint("verifying", 95); identity = adapter.verify(job, device)
                terminal_finish("completed", remote_post_identity=identity)
        except JobCancelled:
            if state["terminal_attempted"]: raise
            terminal_finish("review_required" if state["final_intent"] else "cancelled", error_code="JOB_CANCELLED")
        except Exception as error:
            if state["terminal_attempted"]: raise
            uncertain = state["final_intent"] or isinstance(error, PublisherError) and error.final_action_uncertain
            terminal_finish("review_required" if uncertain else "failed", error_code=getattr(error, "code", "WORKER_ERROR"))
        finally:
            stop_heartbeat()
            if device is not None:
                try: adapter.cleanup(job, device)
                except Exception: pass
                if remote_path:
                    try: device.remove(remote_path)
                    except Exception: pass
        return True
    def run_forever(self, device_id: int, *, stop: threading.Event, sleep: Callable[[float], None] = time.sleep, random_value: Callable[[], float] = random.random) -> None:
        while not stop.is_set():
            try: claimed = self.run_once(device_id)
            except PublisherError: claimed = False
            if not claimed and not stop.is_set(): sleep(self.backoff_seconds(random_value))

def _normalized_accounts(value: str) -> set[str]:
    return {item.strip().lstrip('@').casefold() for item in value.split(',') if item.strip()}

def _config(env=os.environ) -> tuple[PublisherApiClient, AdbDeviceRegistry, int, set[str]]:
    api_url, token, worker_id, device_id = (env.get(key, "").strip() for key in ("SOUTHFARM_API_URL", "SOUTHFARM_PUBLISHER_WORKER_TOKEN", "SOUTHFARM_PUBLISHER_WORKER_ID", "SOUTHFARM_PUBLISHER_DEVICE_ID"))
    if not device_id.isdigit() or int(device_id) <= 0: raise PublisherError("CONFIG_INVALID", "SOUTHFARM_PUBLISHER_DEVICE_ID must be a positive integer")
    adb = env.get("SOUTHFARM_ADB", DEFAULT_ADB)
    if not os.path.isfile(adb) or not os.access(adb, os.X_OK): raise PublisherError("CONFIG_INVALID", "Configured ADB executable is unavailable")
    expected_serial, expected_android_id = env.get("SOUTHFARM_ADB_SERIAL", "").strip(), env.get("SOUTHFARM_EXPECTED_ANDROID_ID", "").strip()
    if not expected_serial or not expected_android_id: raise PublisherError("CONFIG_INVALID", "Exact ADB serial and Android identity must be configured")
    expected_backend_device_id = env.get("SOUTHFARM_BACKEND_DEVICE_ID", expected_android_id).strip()
    if not expected_backend_device_id: raise PublisherError("CONFIG_INVALID", "Backend device identity must be configured")
    raw_forbidden, allow_all = env.get("SOUTHFARM_FORBIDDEN_INSTAGRAM_ACCOUNTS"), env.get("SOUTHFARM_ALLOW_ALL_INSTAGRAM_ACCOUNTS", "").strip().lower()
    if raw_forbidden is None and allow_all != "true": raise PublisherError("CONFIG_INVALID", "Instagram forbidden-account policy must be configured")
    return PublisherApiClient(api_url, token, worker_id), AdbDeviceRegistry(adb_path=adb, expected_serial=expected_serial, expected_android_id=expected_android_id, expected_backend_device_id=expected_backend_device_id), int(device_id), _normalized_accounts(raw_forbidden or "")

def platform_adapters(*, forbidden_instagram_accounts: set[str] | None = None) -> dict[str, Any]:
    from .platforms import InstagramPublisher, TikTokPublisher, YouTubeShortPublisher
    def configured(cls: Any, forbidden: set[str] | None = None) -> Callable[[Any], Any]:
        def build(job: Any) -> Any:
            account = getattr(job, 'account', {})
            expected = account.get('username') if isinstance(account, dict) else None
            if not isinstance(expected, str) or not expected.strip():
                raise PublisherError('ACCOUNT_SNAPSHOT_INVALID', 'Publication job lacks a safe expected account')
            return cls(expected_account=expected, forbidden_accounts=forbidden)
        return build
    return {"instagram": configured(InstagramPublisher, forbidden_instagram_accounts), "tiktok": configured(TikTokPublisher), "youtube": configured(YouTubeShortPublisher)}

def main() -> None:
    api, registry, device_id, forbidden = _config()
    PublicationRunner(api, registry, platform_adapters(forbidden_instagram_accounts=forbidden)).run_forever(device_id, stop=threading.Event())
if __name__ == "__main__": main()
