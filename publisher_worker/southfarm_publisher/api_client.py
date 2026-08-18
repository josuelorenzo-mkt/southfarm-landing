from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .models import ClaimedJob, PublicationJob, PublisherError


class PublisherApiClient:
    def __init__(self, api_url: str, token: str, worker_id: str, *, opener: Callable[..., Any] = urlopen, timeout: float = 15.0):
        if not api_url.startswith(("http://", "https://")) or not token or not worker_id:
            raise PublisherError("CONFIG_INVALID", "Publisher worker configuration is incomplete")
        self.api_url = api_url.rstrip("/"); self._token = token; self.worker_id = worker_id; self._opener = opener; self.timeout = min(max(float(timeout), 1.0), 30.0)

    def _headers(self, claim_token: str | None = None, json_body: bool = False) -> dict[str, str]:
        headers = {"Authorization": f"Bearer {self._token}", "X-SouthFarm-Worker-Id": self.worker_id}
        if claim_token: headers["X-SouthFarm-Claim-Token"] = claim_token
        if json_body: headers["Content-Type"] = "application/json"
        return headers

    def _request(self, method: str, endpoint: str, payload: dict[str, Any] | None = None, claim_token: str | None = None) -> Any:
        body = json.dumps(payload).encode("utf-8") if payload is not None else None
        request = Request(self.api_url + endpoint, data=body, headers=self._headers(claim_token, payload is not None), method=method)
        try:
            return self._opener(request, timeout=self.timeout)
        except HTTPError as error:
            detail = "Worker request was rejected" if error.code in (401, 403) else "Worker request failed"
            raise PublisherError("HTTP_%s" % error.code, detail, retryable=error.code >= 500) from None
        except (URLError, OSError, TimeoutError):
            raise PublisherError("NETWORK_ERROR", "Worker network request failed", retryable=True) from None

    def _json(self, method: str, endpoint: str, payload: dict[str, Any] | None = None, claim_token: str | None = None) -> dict[str, Any]:
        response = self._request(method, endpoint, payload, claim_token)
        try:
            data = json.loads(response.read().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise PublisherError("RESPONSE_INVALID", "Worker API returned invalid JSON") from None
        finally: response.close()
        if not isinstance(data, dict): raise PublisherError("RESPONSE_INVALID", "Worker API returned invalid JSON")
        return data

    def claim(self, device_id: int) -> ClaimedJob | None:
        data = self._json("POST", "/api/publication-worker/claim", {"worker_id": self.worker_id, "device_id": device_id})
        if not data.get("claimed"): return None
        token = data.get("claim_token")
        if not isinstance(token, str) or not token: raise PublisherError("CLAIM_INVALID", "Worker API returned an invalid claim")
        return ClaimedJob(PublicationJob.from_json(data.get("job") or {}), token)

    def heartbeat(self, job_id: int, claim_token: str) -> dict[str, Any]: return self._json("POST", f"/api/publication-worker/jobs/{job_id}/heartbeat", {"worker_id": self.worker_id, "claim_token": claim_token}, claim_token)
    def checkpoint(self, job_id: int, claim_token: str, step: str, progress: int, *, final_action: bool = False, evidence: Any = None) -> dict[str, Any]:
        body: dict[str, Any] = {"worker_id": self.worker_id, "claim_token": claim_token, "step": step, "progress_percent": progress}
        if final_action: body["final_action"] = True
        if evidence is not None: body["evidence"] = evidence
        return self._json("POST", f"/api/publication-worker/jobs/{job_id}/checkpoint", body, claim_token)
    def finish(self, job_id: int, claim_token: str, status: str, **metadata: Any) -> dict[str, Any]:
        body = {"worker_id": self.worker_id, "claim_token": claim_token, "status": status, **metadata}
        return self._json("POST", f"/api/publication-worker/jobs/{job_id}/finish", body, claim_token)
    def availability(self, device_id: int) -> dict[str, Any]: return self._json("GET", f"/api/publication-worker/devices/{device_id}/availability")
    def validate_cleanup_authorization(self, authorization: str, device_id: int) -> dict[str, Any]:
        value = self._json("POST", f"/api/publication-worker/test-cleanup-authorizations/{authorization}/validate", {"device_id": device_id})
        cleanup = value.get("cleanup")
        if not isinstance(cleanup, dict): raise PublisherError("CLEANUP_AUTHORIZATION_INVALID", "Backend cleanup authorization is invalid")
        return cleanup
    def consume_cleanup_authorization(self, authorization: str, device_id: int) -> dict[str, Any]:
        value = self._json("POST", f"/api/publication-worker/test-cleanup-authorizations/{authorization}/consume", {"device_id": device_id})
        cleanup = value.get("cleanup")
        if not isinstance(cleanup, dict): raise PublisherError("CLEANUP_AUTHORIZATION_INVALID", "Backend cleanup authorization is invalid")
        return cleanup

    def download_media(self, media_id: int, claim_token: str, target: str | Path, metadata: dict[str, Any]) -> Path:
        target = Path(target); target.parent.mkdir(parents=True, exist_ok=True); partial = target.with_suffix(target.suffix + ".part")
        response = None
        try:
            response = self._request("GET", f"/api/publication-worker/media/{media_id}", claim_token=claim_token)
            digest = hashlib.sha256(); count = 0
            with partial.open("wb") as handle:
                while chunk := response.read(1024 * 1024): handle.write(chunk); digest.update(chunk); count += len(chunk)
            if count != int(metadata["size_bytes"]) or digest.hexdigest().lower() != str(metadata["sha256"]).lower():
                raise PublisherError("MEDIA_HASH_MISMATCH", "Downloaded media did not match its verified metadata")
            os.replace(partial, target); return target
        except Exception:
            for candidate in (target, partial):
                try: candidate.unlink()
                except FileNotFoundError: pass
            raise
        finally:
            if response is not None: response.close()
