from __future__ import annotations

import re
import time
from typing import Any, Callable

from ..adb_device import SafeAdb
from ..models import PublisherError


def word_count(caption: str) -> int:
    return len(re.findall(r"\S+", caption or ""))


def validate_caption(caption: str, *, youtube: bool = False) -> None:
    if not 1 <= word_count(caption) <= 10:
        raise PublisherError("CAPTION_INVALID", "Captions must contain between 1 and 10 words")
    if youtube and len(caption) > 100:
        raise PublisherError("CAPTION_TOO_LONG", "YouTube captions must contain at most 100 characters")


def enabled(node: dict[str, str]) -> bool:
    return node.get("enabled", "true").lower() != "false" and node.get("clickable", "true").lower() != "false"


class GuardedPublisher:
    package = ""

    def __init__(self, *, expected_account: str | None = None, pause: Callable[[float], None] = time.sleep):
        self.expected_account, self._pause = expected_account, pause

    def _require_package(self, device: Any) -> None:
        current = device.foreground_package()
        if current != self.package:
            raise PublisherError("WRONG_PACKAGE", "Expected social application is not in foreground", retryable=True)

    def _launch(self, device: Any) -> None:
        device.command("shell", "monkey", "-p", self.package, "1")

    def _nodes(self, device: Any) -> list[dict[str, str]]:
        self._require_package(device)
        nodes = device.dump_ui()
        if not isinstance(nodes, list):
            raise PublisherError("UI_DUMP_INVALID", "Device UI dump is invalid", retryable=True)
        return nodes

    @staticmethod
    def _matches(node: dict[str, str], *, text: str | None = None, content_desc: str | None = None, resource_id: str | None = None) -> bool:
        return (text is None or node.get("text") == text) and (content_desc is None or node.get("content-desc") == content_desc) and (resource_id is None or node.get("resource-id") == resource_id)

    def _one(self, nodes: list[dict[str, str]], *, error: str, text: str | None = None, content_desc: str | None = None, resource_id: str | None = None, required: bool = True) -> dict[str, str] | None:
        matches = [node for node in nodes if self._matches(node, text=text, content_desc=content_desc, resource_id=resource_id)]
        if len(matches) > 1:
            raise PublisherError("SELECTOR_COLLISION", f"Ambiguous {error} selector")
        if not matches:
            if required: raise PublisherError(error, f"Required {error} control is absent", retryable=True)
            return None
        if not enabled(matches[0]): raise PublisherError("CONTROL_DISABLED", f"Required {error} control is disabled")
        SafeAdb.bounds(matches[0])
        return matches[0]

    def _tap(self, device: Any, node: dict[str, str]) -> None:
        device.tap_bounds(SafeAdb.bounds(node))

    def _account(self, nodes: list[dict[str, str]]) -> None:
        if not self.expected_account:
            return
        exact = [node for node in nodes if node.get("text") == self.expected_account or node.get("content-desc") == self.expected_account]
        if len(exact) != 1:
            raise PublisherError("ACCOUNT_MISMATCH", "Expected authenticated account label is absent or ambiguous")

    def _caption(self, device: Any, caption: str, *, youtube: bool = False) -> None:
        validate_caption(caption, youtube=youtube)
        words = caption.split()
        for index, word in enumerate(words):
            device.text((" " if index else "") + word)
            nodes = self._nodes(device)
            expected = " ".join(words[:index + 1])
            visible = " ".join((node.get("text") or "") for node in nodes)
            # UIAutomator sometimes omits the active text while the keyboard is open.
            # It may not contradict the prefix, but an observable divergence is fatal.
            if visible and any(node.get("class", "").endswith("EditText") or node.get("resource-id", "") for node in nodes) and expected not in visible and words[0] in visible:
                raise PublisherError("CAPTION_DIVERGED", "Caption text diverged before publishing")

    def _final(self, device: Any, checkpoint: Callable[..., None], *, button: dict[str, str], context: dict[str, str], evidence: dict[str, Any]) -> None:
        # Context and final button must occur in the same fresh dump.  The checkpoint
        # is intentionally before the one irreversible tap; a thrown checkpoint leaves it untouched.
        nodes = self._nodes(device)
        if not any(all(node.get(key) == value for key, value in context.items()) for node in nodes):
            raise PublisherError("FINAL_CONTEXT_MISSING", "Final publish context is absent")
        selected = self._one(nodes, error="FINAL_ACTION", text=button.get("text"), content_desc=button.get("content-desc"), resource_id=button.get("resource-id"))
        checkpoint("publishing", 90, final_action=True, evidence=evidence)
        self._tap(device, selected)

    def _identity(self, nodes: list[dict[str, str]], caption: str, *, marker: str) -> str:
        prefix = caption.strip().lower()
        matches = []
        for node in nodes:
            value = f"{node.get('text', '')} {node.get('content-desc', '')}".lower()
            if prefix in value and marker.lower() in value:
                matches.append(node)
        if len(matches) != 1:
            raise PublisherError("VERIFICATION_MISSING", "The exact newly published item is not uniquely visible", retryable=True, final_action_uncertain=True)
        return matches[0].get("content-desc") or matches[0].get("text") or caption

    def cleanup_test_post(self, expected_identity: str, baseline: set[str], device: Any) -> None:
        # This deliberately has no call site in normal jobs. It refuses to delete
        # unless exactly the proved identity is visible and the expected baseline is preserved.
        nodes = self._nodes(device)
        identities = {node.get("content-desc") or node.get("text") for node in nodes if node.get("content-desc") or node.get("text")}
        if expected_identity not in identities or not baseline.issubset(identities):
            raise PublisherError("CLEANUP_IDENTITY_MISMATCH", "Refusing test cleanup without the exact verified item and baseline")
        target = self._one(nodes, error="CLEANUP_TARGET", content_desc=expected_identity, required=False) or self._one(nodes, error="CLEANUP_TARGET", text=expected_identity)
        self._tap(device, target)
        delete = self._one(self._nodes(device), error="DELETE_CONFIRMATION", text="Delete", required=False)
        if delete is None: raise PublisherError("DELETE_CONFIRMATION", "Test cleanup delete confirmation is absent")
        self._tap(device, delete)
        restored = {node.get("content-desc") or node.get("text") for node in self._nodes(device) if node.get("content-desc") or node.get("text")}
        if expected_identity in restored or not baseline.issubset(restored):
            raise PublisherError("BASELINE_NOT_RESTORED", "Test cleanup did not restore the exact baseline")
