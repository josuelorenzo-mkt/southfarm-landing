from __future__ import annotations

from typing import Any, Callable

from .common import GuardedPublisher, validate_caption
from ..models import PublisherError


class InstagramPublisher(GuardedPublisher):
    package = "com.instagram.android"

    def prepare(self, job: Any, device: Any) -> None:
        self._launch(device); nodes = self._nodes(device); self._account(nodes)
        self._capture_baseline(nodes)
        create = self._one(nodes, error="CREATE_CONTROL", content_desc="Create New", required=False) or self._one(nodes, error="CREATE_CONTROL", text="Create New", required=False)
        if create: self._tap(device, create)

    def publish(self, job: Any, device: Any, checkpoint: Callable[..., None]) -> None:
        self._require_prepared(); validate_caption(job.caption)
        nodes = self._nodes(device)
        if any(node.get("text") == "About Reels" or node.get("resource-id") == "com.instagram.android:id/clips_nux_sheet_share_button" for node in nodes):
            raise PublisherError("MID_FLOW_ABORT", "Instagram was already in a publish flow; refusing to resume")
        else:
            reel = self._one(nodes, error="REEL_SELECTOR", content_desc="Create new reel", required=False) or self._one(nodes, error="REEL_SELECTOR", text="Reel")
            self._tap(device, reel); checkpoint("selecting_media", 25, evidence={"platform": "instagram", "stage": "reel"})
            media = self._one(self._nodes(device), error="MEDIA_SELECTOR", content_desc=f"publication-{job.id}-{job.media_id}.{job.media['file_extension']}", required=False)
            if media is None: raise PublisherError("MEDIA_MISSING", "Exact transferred Reel media is not visible")
            self._tap(device, media)
            editor = self._one(self._nodes(device), error="EDITOR_NEXT", resource_id="com.instagram.android:id/clips_right_action_button")
            self._tap(device, editor); checkpoint("editing", 45, evidence={"platform": "instagram", "stage": "editor"})
            privacy = self._one(self._nodes(device), error="PRIVACY_CONTINUE", text="Continue", required=False)
            if privacy: self._tap(device, privacy)
            field = self._one(self._nodes(device), error="CAPTION_FIELD", text="Write a caption and add hashtags...", required=False)
            if field: self._tap(device, field); self._caption(device, job.caption)
            checkpoint("captioning", 65, evidence={"platform": "instagram", "caption_words": len(job.caption.split())})
            next_button = self._one(self._nodes(device), error="DETAILS_NEXT", text="Next")
            self._tap(device, next_button); checkpoint("ready_to_publish", 80, evidence={"platform": "instagram", "stage": "about_reels"})
        self._final(device, checkpoint, button={"text": "Share", "resource-id": "com.instagram.android:id/clips_nux_sheet_share_button"}, context={"text": "About Reels"}, evidence={"platform": "instagram", "final": "share"})

    def verify(self, job: Any, device: Any) -> str:
        nodes = self._nodes(device); self._account(nodes)
        return self._identity(nodes, job.caption, marker="reel")

    def cleanup(self, job: Any, device: Any) -> None:
        return None

    def cleanup_test_post(self, expected_identity: str, baseline: set[str], device: Any) -> None:
        nodes = self._nodes(device)
        target = self._one(nodes, error="CLEANUP_TARGET", content_desc=expected_identity, required=False) or self._one(nodes, error="CLEANUP_TARGET", text=expected_identity)
        self._tap(device, target)
        menu = self._one(self._nodes(device), error="REEL_MENU", content_desc="More options", required=False) or self._one(self._nodes(device), error="REEL_MENU", text="More options")
        self._tap(device, menu)
        self._tap(device, self._one(self._nodes(device), error="DELETE_ACTION", text="Delete"))
        self._tap(device, self._one(self._nodes(device), error="DELETE_CONFIRMATION", text="Delete"))
        restored = {value for node in self._nodes(device) for value in (node.get("content-desc"), node.get("text")) if value}
        if expected_identity in restored or restored != baseline: raise PublisherError("BASELINE_NOT_RESTORED", "Instagram cleanup did not restore exact baseline")
