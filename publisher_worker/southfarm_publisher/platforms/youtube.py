from __future__ import annotations

from typing import Any, Callable

from .common import GuardedPublisher, validate_caption
from ..models import PublisherError


class YouTubeShortPublisher(GuardedPublisher):
    package = "com.google.android.youtube"

    def prepare(self, job: Any, device: Any) -> None:
        self._launch(device); nodes = self._nodes(device); self._account(nodes)
        self._capture_baseline(nodes)
        short = self._one(nodes, error="SHORT_SELECTOR", text="Short", resource_id="com.google.android.youtube:id/creation_mode_button", required=False)
        if short is None: raise PublisherError("SHORT_SELECTOR", "Exact YouTube Short control is absent")
        self._tap(device, short)

    def publish(self, job: Any, device: Any, checkpoint: Callable[..., None]) -> None:
        self._require_prepared(); validate_caption(job.caption, youtube=True); nodes = self._nodes(device)
        if any(node.get("text") == "Caption your Short" for node in nodes):
            raise PublisherError("MID_FLOW_ABORT", "YouTube was already in a publish flow; refusing to resume")
        else:
            add = self._one(nodes, error="IMPORT_SELECTOR", resource_id="com.google.android.youtube:id/reel_camera_gallery_button_delegate", required=False) or self._one(nodes, error="IMPORT_SELECTOR", content_desc="Import video from photo library")
            self._tap(device, add); checkpoint("selecting_media", 25, evidence={"platform": "youtube", "remote_name": f"publication-{job.id}-{job.media_id}.{job.media['file_extension']}"})
            remote = f"publication-{job.id}-{job.media_id}.{job.media['file_extension']}"
            items = [node for node in self._nodes(device) if node.get("content-desc") == remote and node.get("resource-id") == "com.google.android.youtube:id/thumb_image_view"]
            if len(items) != 1: raise PublisherError("MEDIA_AMBIGUOUS", "Exact YouTube gallery media is absent or ambiguous")
            self._tap(device, items[0])
            self._tap(device, self._one(self._nodes(device), error="GALLERY_NEXT", text="Next", resource_id="com.google.android.youtube:id/multi_select_next_button"))
            self._tap(device, self._one(self._nodes(device), error="TRIM_DONE", text="Done", resource_id="com.google.android.youtube:id/creation_next_button"))
            self._tap(device, self._one(self._nodes(device), error="EDITOR_NEXT", text="Next", resource_id="com.google.android.youtube:id/shorts_post_bottom_button")); checkpoint("editing", 45, evidence={"platform": "youtube", "stage": "editor"})
        field = self._one(self._nodes(device), error="CAPTION_FIELD", text="Caption your Short")
        self._tap(device, field); self._caption(device, job.caption, youtube=True); checkpoint("captioning", 65, evidence={"platform": "youtube", "caption_words": len(job.caption.split())})
        details = self._nodes(device)
        if any(node.get("text") in {"Private", "Unlisted"} for node in details) or not any(node.get("text") == "Public" for node in details): raise PublisherError("VISIBILITY_NOT_PUBLIC", "YouTube public visibility is not explicitly visible")
        checkpoint("ready_to_publish", 80, evidence={"platform": "youtube", "stage": "details"})
        self._final(device, checkpoint, button={"text": "Upload Short", "resource-id": "com.google.android.youtube:id/upload_bottom_button"}, context={"text": "Caption your Short"}, evidence={"platform": "youtube", "final": "upload_short"})

    def verify(self, job: Any, device: Any) -> str:
        you = self._one(self._nodes(device), error="YOU_TAB", text="You", required=False) or self._one(self._nodes(device), error="YOU_TAB", content_desc="You")
        self._tap(device, you)
        channel = self._one(self._nodes(device), error="VIEW_CHANNEL", content_desc="View channel")
        self._tap(device, channel)
        return self._identity(self._nodes(device), job.caption, marker="play short")

    def cleanup(self, job: Any, device: Any) -> None:
        return None

    def cleanup_test_post(self, expected_identity: str, baseline: set[str], device: Any) -> None:
        nodes = self._nodes(device)
        target = self._one(nodes, error="CLEANUP_TARGET", content_desc=expected_identity, required=False) or self._one(nodes, error="CLEANUP_TARGET", text=expected_identity)
        self._tap(device, target)
        menu = self._one(self._nodes(device), error="MORE_ACTIONS", content_desc="More actions")
        self._tap(device, menu)
        self._tap(device, self._one(self._nodes(device), error="DELETE_ACTION", text="Delete"))
        self._tap(device, self._one(self._nodes(device), error="DELETE_CONFIRMATION", text="Delete"))
        restored = {value for node in self._nodes(device) for value in (node.get("content-desc"), node.get("text")) if value}
        if expected_identity in restored or restored != baseline: raise PublisherError("BASELINE_NOT_RESTORED", "YouTube cleanup did not restore exact baseline")
