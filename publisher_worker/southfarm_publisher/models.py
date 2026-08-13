from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any


class PublicationStatus(StrEnum):
    QUEUED = "queued"; CLAIMED = "claimed"; PREPARING = "preparing"; TRANSFERRING = "transferring"
    SELECTING_MEDIA = "selecting_media"; EDITING = "editing"; CAPTIONING = "captioning"; READY_TO_PUBLISH = "ready_to_publish"
    PUBLISHING = "publishing"; VERIFYING = "verifying"; COMPLETED = "completed"; CANCELLED = "cancelled"
    FAILED = "failed"; REVIEW_REQUIRED = "review_required"


class PublisherError(RuntimeError):
    def __init__(self, code: str, message: str, retryable: bool = False, final_action_uncertain: bool = False):
        self.code, self.retryable, self.final_action_uncertain = code, retryable, final_action_uncertain
        super().__init__(message)


class JobCancelled(PublisherError):
    def __init__(self): super().__init__("JOB_CANCELLED", "Publication cancellation was requested")


@dataclass(frozen=True)
class PublicationJob:
    id: int
    device_id: int
    media_id: int
    platform: str
    caption: str
    media: dict[str, Any] = field(default_factory=dict)
    status: str = "claimed"

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> "PublicationJob":
        try:
            if type(value) is not dict: raise TypeError("claim job must be a dict")
            job_id, device_id, media_id = value["id"], value["device_id"], value["media_id"]
            if any(type(item) is not int or item <= 0 for item in (job_id, device_id, media_id)): raise ValueError("invalid job identifiers")
            platform, caption, status = value["platform"], value["caption"], value.get("status", "claimed")
            if type(platform) is not str or platform not in {"instagram", "tiktok", "youtube"} or type(caption) is not str or not caption.strip() or not 1 <= len(caption.split()) <= 10 or (platform == "youtube" and len(caption) > 100) or type(status) is not str or status != "claimed": raise ValueError("invalid job fields")
            media = value["media"]
            if type(media) is not dict: raise TypeError("media must be a dict")
            allowed_extensions = {"video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm"}
            if set(media) != {"id", "size_bytes", "sha256", "mime_type", "file_extension"} or type(media["id"]) is not int or media["id"] != media_id or type(media["size_bytes"]) is not int or media["size_bytes"] <= 0 or type(media["sha256"]) is not str or len(media["sha256"]) != 64 or media["sha256"] != media["sha256"].lower() or any(character not in "0123456789abcdef" for character in media["sha256"]):
                raise ValueError("invalid media metadata")
            if type(media["mime_type"]) is not str or type(media["file_extension"]) is not str or allowed_extensions.get(media["mime_type"]) != media["file_extension"]: raise ValueError("invalid media metadata")
            return cls(id=job_id, device_id=device_id, media_id=media_id, platform=platform, caption=caption, media=media, status=status)
        except (KeyError, TypeError, ValueError) as error:
            raise PublisherError("JOB_INVALID", "Claim response contains an invalid publication job") from error


@dataclass(frozen=True)
class ClaimedJob:
    job: PublicationJob
    claim_token: str
