from __future__ import annotations

import os
import random
import tempfile
import threading
from pathlib import Path
from typing import Any

from .models import JobCancelled, PublisherError

class PublicationRunner:
    def __init__(self, api: Any, registry: Any, adapters: dict[str, Any], *, temp_dir: str | None = None, heartbeat_interval: float = 20.0):
        self.api, self.registry, self.adapters = api, registry, adapters; self.temp_dir = temp_dir; self.heartbeat_interval = min(max(1.0, heartbeat_interval), 44.0)
    @staticmethod
    def backoff_seconds(random_value=random.random) -> float: return min(30.0, max(2.0, 2.0 + float(random_value()) * 28.0))
    def _heartbeat_once(self, job_id: int, claim_token: str) -> None:
        if self.api.heartbeat(job_id, claim_token).get("cancel_requested"): raise JobCancelled()
    def run_once(self, device_id: int) -> bool:
        claim = self.api.claim(device_id)
        if not claim: return False
        job, token, adapter = claim.job, claim.claim_token, self.adapters.get(claim.job.platform)
        if adapter is None: self.api.finish(job.id, token, "failed", error_code="PLATFORM_UNSUPPORTED"); return True
        action_state = {"final": False}; stop = threading.Event(); heartbeat_error: list[Exception] = []
        def heartbeat_loop():
            while not stop.wait(self.heartbeat_interval):
                try: self._heartbeat_once(job.id, token)
                except Exception as error: heartbeat_error.append(error); stop.set()
        thread = threading.Thread(target=heartbeat_loop, daemon=True); thread.start()
        local_path: Path | None = None; device = None
        try:
            availability = self.api.availability(job.device_id)
            device_identity = (availability.get("device") or {}).get("device_id")
            if not availability.get("available") or not isinstance(device_identity, str) or not device_identity:
                raise PublisherError("DEVICE_UNAVAILABLE", "The assigned device is not available", retryable=True)
            device = self.registry.open(device_identity)
            self._heartbeat_once(job.id, token)
            with tempfile.TemporaryDirectory(dir=self.temp_dir) as directory:
                local_path = Path(directory) / f"publication-{job.id}.mp4"
                self.api.download_media(job.media_id, token, local_path, job.media)
                remote_path = f"/sdcard/Movies/SouthFarm/publication-{job.id}-{job.media_id}.mp4"
                self.api.checkpoint(job.id, token, "transferring", 5)
                device.push(str(local_path), remote_path); device.scan_media(remote_path)
                def checkpoint(step: str, progress: int, final_action: bool = False, evidence: Any = None):
                    if heartbeat_error: raise heartbeat_error[0]
                    self._heartbeat_once(job.id, token)
                    self.api.checkpoint(job.id, token, step, progress, final_action=final_action, evidence=evidence)
                    if final_action: action_state["final"] = True
                adapter.prepare(job, device); adapter.publish(job, device, checkpoint)
                if heartbeat_error: raise heartbeat_error[0]
                identity = adapter.verify(job, device)
                self.api.finish(job.id, token, "completed", remote_post_identity=identity)
        except JobCancelled:
            self.api.finish(job.id, token, "review_required" if action_state["final"] else "cancelled", error_code="JOB_CANCELLED")
        except Exception as error:
            uncertain = action_state["final"] or isinstance(error, PublisherError) and error.final_action_uncertain
            self.api.finish(job.id, token, "review_required" if uncertain else "failed", error_code=getattr(error, "code", "WORKER_ERROR"))
        finally:
            stop.set(); thread.join(timeout=1)
            if device is not None:
                try: adapter.cleanup(job, device)
                except Exception: pass
                try: device.remove(f"/sdcard/Movies/SouthFarm/publication-{job.id}-{job.media_id}.mp4")
                except Exception: pass
            if local_path:
                try: os.unlink(local_path)
                except FileNotFoundError: pass
        return True

def main() -> None:
    raise SystemExit("Configure the publisher worker through the Windows supervisor")
if __name__ == "__main__": main()
