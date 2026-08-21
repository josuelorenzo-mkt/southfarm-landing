export declare const EXECUTABLE_TASK_TYPES: readonly ["warmup_ig", "warmup_tiktok", "warmup_youtube", "scan_instagram", "scan_tiktok", "scan_youtube"];
/**
 * Task types the claim endpoint may hand out: the base EXECUTABLE_TASK_TYPES
 * plus any extra types enabled at runtime via SOUTHFARM_EXTRA_EXECUTABLE_TYPES
 * (comma-separated, trimmed, empty entries dropped, deduplicated against the
 * base). The env var is read on every call, so a process restart with a new
 * value takes effect without code changes. This is how new types (currently
 * publish_reel, which the Android app cannot execute yet) are staged on STAGING
 * while production keeps the base list.
 */
export declare function executableTaskTypes(): string[];
