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

    def __init__(self, *, expected_account: str, forbidden_accounts: set[str] | None = None, pause: Callable[[float], None] = time.sleep, timeout: float = 15.0, poll: float = 0.5):
        if not isinstance(expected_account, str) or not expected_account.strip():
            raise PublisherError("ACCOUNT_SNAPSHOT_INVALID", "A non-empty expected social account is required")
        self.expected_account = expected_account.strip()
        self.forbidden_accounts = {item.strip().lstrip('@').casefold() for item in (forbidden_accounts or ()) if item.strip()}
        self._pause, self.timeout, self.poll = pause, max(0.1, float(timeout)), max(0.05, float(poll))
        self._prepared = False
        self._baseline: set[str] = set()

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
        self._last_nodes = nodes
        return nodes

    def wait_for(self, device: Any, *, error: str, text: str | None = None, content_desc: str | None = None, resource_id: str | None = None, context: dict[str, str] | None = None, predicate: Callable[[list[dict[str, str]]], dict[str, str] | None] | None = None, clock: Callable[[], float] = time.monotonic) -> dict[str, str]:
        deadline = clock() + self.timeout
        while True:
            nodes = self._nodes(device)
            if predicate is not None:
                found = predicate(nodes)
                if found is not None: return found
            elif context is None or any(all(item.get(key) == value for key, value in context.items()) for item in nodes):
                found = self._one(nodes, error=error, text=text, content_desc=content_desc, resource_id=resource_id, required=False)
                if found is not None: return found
            if clock() >= deadline: raise PublisherError("UI_TIMEOUT", f"Timed out waiting for {error}", retryable=True)
            self._pause(self.poll)

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

    def tap_and_wait(self, device: Any, node: dict[str, str], *, error: str, text: str | None = None, content_desc: str | None = None, resource_id: str | None = None, context: dict[str, str] | None = None, predicate: Callable[[list[dict[str, str]]], dict[str, str] | None] | None = None) -> dict[str, str]:
        """Perform one reversible navigation tap, then require a fresh next screen."""
        # An ADB tap returning successfully is not evidence that the app accepted it.
        # Take an immediately-before dump and refuse to accept a target from that
        # same UI revision (for example a stale dialog already left on screen).
        before = self._nodes(device)
        before_fingerprint = self._screen_fingerprint(before)
        selected = self._one(before, error="STALE_CONTROL", text=node.get("text"), content_desc=node.get("content-desc"), resource_id=node.get("resource-id"))
        self._tap(device, selected)
        return self._wait_for_fresh(device, before_fingerprint, error=error, text=text, content_desc=content_desc, resource_id=resource_id, context=context, predicate=predicate)

    @staticmethod
    def _screen_fingerprint(nodes: list[dict[str, str]]) -> tuple[tuple[tuple[str, str], ...], ...]:
        return tuple(sorted(tuple(sorted((str(key), str(value)) for key, value in node.items())) for node in nodes))

    def _wait_for_fresh(self, device: Any, before_fingerprint: tuple[tuple[tuple[str, str], ...], ...], *, error: str, text: str | None = None, content_desc: str | None = None, resource_id: str | None = None, context: dict[str, str] | None = None, predicate: Callable[[list[dict[str, str]]], dict[str, str] | None] | None = None, clock: Callable[[], float] = time.monotonic) -> dict[str, str]:
        deadline = clock() + self.timeout
        while True:
            nodes = self._nodes(device)
            if self._screen_fingerprint(nodes) != before_fingerprint:
                if predicate is not None:
                    found = predicate(nodes)
                elif context is None or any(all(item.get(key) == value for key, value in context.items()) for item in nodes):
                    found = self._one(nodes, error=error, text=text, content_desc=content_desc, resource_id=resource_id, required=False)
                else:
                    found = None
                if found is not None:
                    return found
            if clock() >= deadline:
                raise PublisherError("UI_TIMEOUT", f"Timed out waiting for fresh {error}", retryable=True)
            self._pause(self.poll)

    def _account(self, nodes: list[dict[str, str]]) -> None:
        if self.expected_account.lstrip('@').casefold() in self.forbidden_accounts:
            raise PublisherError("FORBIDDEN_ACCOUNT", "This social account is forbidden for publishing")
        exact = [node for node in nodes if node.get("text") == self.expected_account or node.get("content-desc") == self.expected_account]
        if len(exact) != 1:
            raise PublisherError("ACCOUNT_MISMATCH", "Expected authenticated account label is absent or ambiguous")

    def _capture_baseline(self, nodes: list[dict[str, str]]) -> None:
        self._baseline = {value for node in nodes for value in (node.get("content-desc"), node.get("text")) if value}
        self._prepared = True

    @staticmethod
    def _tile_signature(node: dict[str, str]) -> tuple[str, str, str, str]:
        # Bounds are display positions, not a media identity: inserting a first
        # tile shifts every existing item.  Keep only stable UI identity fields.
        return (node.get("resource-id", ""), node.get("content-desc", ""), node.get("text", ""), node.get("class", ""))

    def _capture_gallery_baseline(self, nodes: list[dict[str, str]], predicate: Callable[[dict[str, str]], bool]) -> None:
        self._gallery_baseline = {self._tile_signature(node) for node in nodes if predicate(node)}

    def _new_gallery_tile(self, nodes: list[dict[str, str]], predicate: Callable[[dict[str, str]], bool], *, baseline_predicate: Callable[[dict[str, str]], bool] | None = None) -> dict[str, str]:
        current = {self._tile_signature(node) for node in nodes if (baseline_predicate or predicate)(node)}
        baseline = getattr(self, "_gallery_baseline", set())
        if not baseline.issubset(current):
            raise PublisherError("MEDIA_BASELINE_MISSING", "Gallery baseline changed unexpectedly")
        candidates = [node for node in nodes if predicate(node) and self._tile_signature(node) not in baseline]
        if len(candidates) != 1: raise PublisherError("MEDIA_AMBIGUOUS", "Gallery must contain exactly one new verified video tile")
        self._chosen_tile = self._tile_signature(candidates[0])
        return candidates[0]

    def _require_prepared(self) -> None:
        if not self._prepared:
            raise PublisherError("FLOW_NOT_PREPARED", "Publication must begin from the verified account profile and baseline")

    def _caption(self, device: Any, caption: str, *, youtube: bool = False) -> None:
        validate_caption(caption, youtube=youtube)
        words = caption.split()
        for index, word in enumerate(words):
            device.text((" " if index else "") + word)
            nodes = self._nodes(device)
            expected = " ".join(words[:index + 1])
            fields = [node for node in nodes if node.get("class", "").endswith("EditText")]
            if len(fields) != 1:
                raise PublisherError("CAPTION_NOT_OBSERVABLE", "Active caption field is absent or ambiguous")
            observed = " ".join((fields[0].get("text") or fields[0].get("content-desc") or "").split())
            if observed != expected:
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
        identity = matches[0].get("content-desc") or matches[0].get("text") or caption
        if identity in self._baseline:
            raise PublisherError("VERIFICATION_NO_DELTA", "The matching item predates this publication", retryable=True, final_action_uncertain=True)
        return identity

    def _cleanup_preflight(self, expected_identity: str, baseline: set[str], device: Any) -> list[dict[str, str]]:
        if not expected_identity or expected_identity in baseline:
            raise PublisherError("CLEANUP_IDENTITY_MISMATCH", "Cleanup identity must be a new verified item")
        nodes = self._nodes(device); self._account(nodes)
        identities = {node.get("content-desc") or node.get("text") for node in nodes if (node.get("content-desc") or node.get("text")) and (node.get("content-desc") or node.get("text")) not in {"More actions", "More options"}}
        if identities != baseline | {expected_identity}:
            raise PublisherError("CLEANUP_IDENTITY_MISMATCH", "Cleanup screen must contain exactly baseline plus verified item")
        return nodes
