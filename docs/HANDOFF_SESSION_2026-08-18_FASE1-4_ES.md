# Handoff — Sesión del 2026-08-18 (FASE 1-4 completadas, FASE 2 preparada)

Continuación de `HANDOFF_WEB_FUNCTIONAL_2026-08-18_ES.md`. Esa ruta se reordenó con aprobación del usuario a: **1 → 3 → 4 → 2 → 5** (trabajo autónomo primero, sesión en vivo al final).

## Estado de merges (repo `southfarm-landing`, base `master`)

- **PR #1 MERGEADO** (`92c17c4`): toda la iniciativa del worker (8 commits nuevos del cierre + los 94 previos de la rama).
- **PR #2 ABIERTO** (`feat/publication-review-resolution`, 4 commits): FASE 3 backend + FASE 4.
  - `730a4d6` resolución manual de `review_required`: dominio (`resolveReview`, transiciones `review_required: ['completed','failed']`, guard `final_action_at` con excepción quirúrgica `review_required→failed`), ruta `POST /api/publications/:id/review` (roles owner/admin/operator). Confirm → `completed` (setea `verified_at`, PRESERVA `result` del worker con append). Dismiss → `failed` (`REVIEW_DISMISSED`). El claim gate descongela la cuenta al resolver.
  - `dcf5506` rebuild dist.
  - `f179aae` `result` (evidencia del worker) restringido a roles de gestión; viewers no lo reciben (fail-closed por default en `safePublication`).
  - `109acdd` media guard: `PLATFORM_MEDIA_RULES` (1080×1920 máx, h264/hevc) validado al crear la publicación → `400 MEDIA_UNSUPPORTED` con codec+dimensiones en el mensaje. Fail-closed sin metadata.
- **Webapp PR #1 ABIERTO** (`josuelorenzo-mkt/southfarm-webapp`, base `main`, 2 commits `5e83a8e`+`007afe6`): pestaña Revisión con evidencia + botones Confirmar/Marcar fallida, nota opcional al descartar (textarea 200 chars), y fix estructural: `AuthApiError` ahora propaga `error_code` (antes el mapeo de `ERROR_MESSAGES` nunca se disparaba).

Review cruzado (reviewer-pro): APROBADO; hallazgos 1/2/4 corregidos (nota, gate por rol, test 409). Suites: 3 scripts test-publications* verde, vitest 27/27, tsc limpio, worker Python 255 OK.

## FASE 2 — prep ya validado (2026-08-18, sin teléfono)

- Harness local arriba: `cd backend && SOUTHFARM_TEST_NODE_PATH=<node22> <node22> scripts/local-pub-e2e.mjs --video ".../0730 MA-V-1.mp4" --keep` → backend `http://127.0.0.1:3325`, owner `local-e2e-1787087349328@example.test` / `test-password-123`, DB `%TEMP%\southfarm-local-pub-e2e`.
- Webapp dev: `cd webapp && NEXT_PUBLIC_API_URL=http://127.0.0.1:3325 npm run dev` → `http://localhost:3000`.
- Validado en navegador (login, panel, tabs, detalle con timeline, cancelar job) y media guard por API (clip HEVC 2160×3840 generado en `%TEMP%\southfarm-4k-test.mp4` → rechazo instantáneo con mensaje claro).
- PENDIENTE (requiere usuario + teléfono): crear publicación DESDE LA WEB con un `0730 MA-V-*.mp4`, correr el worker con el env que imprime el harness, ver checkpoints en vivo. Si termina `review_required`, probar los botones de resolución nuevos (cierre del loop completo).

## Notas

- El file upload no se puede automatizar con el navegador IAB de ZCode (file chooser no soportado) — el upload desde la web lo hace el usuario en la sesión en vivo.
- `scheduled_for` exige RFC3339 con offset y fracción de 1-3 dígitos (`Z` o `±HH:MM`; Python: `isoformat(timespec='milliseconds')`).
- No quedan videos 4K reales en `Videos to test` (MP-V-2 fue sobreescrito con una copia 1080p por un agente para un test); para reprobar el guard usar `%TEMP%\southfarm-4k-test.mp4`.
- Desechables siguen untracked a pedido del usuario (diag/, e2e4-*, *-verify-*.py, PNGs).
- Subagentes GOAT (CCGOAT) funcionaron sin rate-limits durante toda la sesión.
