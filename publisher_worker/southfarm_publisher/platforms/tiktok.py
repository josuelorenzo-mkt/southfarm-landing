from __future__ import annotations

from typing import Any, Callable

from .common import GuardedPublisher, validate_caption
from ..models import PublisherError


class TikTokPublisher(GuardedPublisher):
    package = "com.zhiliaoapp.musically"

    def prepare(self, job: Any, device: Any) -> None:
        self._launch(device); nodes = self._nodes(device); self._account(nodes)
        # exact Create is required; Create a Story is a different destructive flow.
        create = self._one(nodes, error="CREATE_CONTROL", content_desc="Create", required=False) or self._one(nodes, error="CREATE_CONTROL", text="Create", required=False)
        if create is None: raise PublisherError("CREATE_CONTROL", "TikTok exact Create control is absent")
        self._tap(device, create)

    def publish(self, job: Any, device: Any, checkpoint: Callable[..., None]) -> None:
        validate_caption(job.caption); nodes = self._nodes(device)
        if not any(node.get("text") == "Add description..." for node in nodes):
            upload = self._one(nodes, error="UPLOAD_SELECTOR", text="Upload", required=False) or self._one(nodes, error="UPLOAD_SELECTOR", resource_id="com.zhiliaoapp.musically:id/upload_hot_area")
            self._tap(device, upload); checkpoint("selecting_media", 25, evidence={"platform": "tiktok", "baseline": "profile"})
            gallery = self._nodes(device); candidates = [node for node in gallery if node.get("resource-id") == "com.zhiliaoapp.musically:id/ica"]
            if len(candidates) != 1: raise PublisherError("MEDIA_AMBIGUOUS", "TikTok gallery media is absent or ambiguous")
            self._tap(device, candidates[0])
            next_one = self._one(self._nodes(device), error="GALLERY_NEXT", text="Next (1)")
            self._tap(device, next_one)
            editor = self._one(self._nodes(device), error="EDITOR_NEXT", text="Next")
            self._tap(device, editor); checkpoint("editing", 45, evidence={"platform": "tiktok", "stage": "editor"})
        field = self._one(self._nodes(device), error="CAPTION_FIELD", text="Add description...", required=False) or self._one(self._nodes(device), error="CAPTION_FIELD", resource_id="com.zhiliaoapp.musically:id/h00")
        self._tap(device, field); self._caption(device, job.caption); checkpoint("captioning", 65, evidence={"platform": "tiktok", "caption_words": len(job.caption.split())})
        details = self._nodes(device)
        if not any(node.get("text") in {"Everyone can view this post", "Public"} for node in details): raise PublisherError("VISIBILITY_NOT_PUBLIC", "TikTok public visibility is not explicitly visible")
        checkpoint("ready_to_publish", 80, evidence={"platform": "tiktok", "stage": "details"})
        self._final(device, checkpoint, button={"text": "Post", "resource-id": "com.zhiliaoapp.musically:id/st6"}, context={"text": "Add description..."}, evidence={"platform": "tiktok", "final": "post"})

    def verify(self, job: Any, device: Any) -> str:
        return self._identity(self._nodes(device), job.caption, marker="0")

    def cleanup(self, job: Any, device: Any) -> None:
        return None
