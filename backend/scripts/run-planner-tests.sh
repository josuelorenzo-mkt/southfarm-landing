#!/usr/bin/env bash
# SouthFarm Activity Planner — integration test runner (FIX 1..8 + addenda).
#
#   scripts/run-planner-tests.sh
#
# Steps:
#   1. npm run build
#   2. consistent copy of staging DB -> southfarm-planner-test.db
#   3. start server on :3103 with the test DB (no seed env) -> run test-planner.mjs
#   4. stop server
#   5. seed test DB (staging copy with all planner data wiped):
#      a. server WITHOUT SOUTHFARM_PLANNER_SEED -> test-planner-seed.mjs (PHASE=nogate)
#      b. stop; restart WITH SOUTHFARM_PLANNER_SEED=1 -> test-planner-seed.mjs (PHASE=gate)
#   6. stop; report combined pass/fail
#
# Windows notes: never start the server through `env ... &` (the PID captured
# is env's, not node's, leaving orphans that answer the health check of the
# next phase). We start `node` directly with inline env vars and stop by
# killing whichever process owns the test port.
set -u

NODE="/c/Users/josu_/AppData/Local/SouthFarm/node-v22.23.1-win-x64/node"
NODE_DIR="$(dirname "$NODE")"
export PATH="$NODE_DIR:$PATH"
export TEST_API="${TEST_API:-http://127.0.0.1:3103}"
export TEST_NODE="$NODE"
PORT="${TEST_PORT:-3103}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$ROOT/data"
STAGING_DB="$DATA/southfarm-planner-staging.db"
TEST_DB="$DATA/southfarm-planner-test.db"
SEED_DB="$DATA/southfarm-planner-seedtest.db"
LOGS="$ROOT/run"
mkdir -p "$LOGS"

# The merged server also boots the publications subsystem (registerPublicationRoutes),
# whose recovery sweep scans SOUTHFARM_PUBLICATION_MEDIA_ROOT at startup. Keep the
# suite isolated from the production media root (C:\ProgramData\SouthFarm\publish-media)
# by pointing it at a local throwaway directory under run/ (gitignored).
TEST_MEDIA_ROOT="$LOGS/test-publish-media"
mkdir -p "$TEST_MEDIA_ROOT"
export SOUTHFARM_PUBLICATION_MEDIA_ROOT="$TEST_MEDIA_ROOT"
# The planner publish bridge inspects uploads with ffprobe (publication media
# rules). Point it at the toolchain copy so the suite does not depend on PATH.
FFPROBE_BIN="/c/Users/josu_/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-essentials_build/bin/ffprobe.exe"
if [ -x "$FFPROBE_BIN" ]; then
  export SOUTHFARM_FFPROBE="$FFPROBE_BIN"
fi

SERVER_PID=""
server_start() { # $1=db path — extra env vars must be EXPORTED by the caller
  local db="$1"
  PORT="$PORT" SOUTHFARM_DB_PATH="$db" "$NODE" "$ROOT/dist/index.js" > "$LOGS/planner-server.log" 2>&1 &
  SERVER_PID=$!
  local i=0
  until curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; do
    i=$((i+1)); [ $i -ge 60 ] && { echo "server did not start (see run/planner-server.log)"; tail -30 "$LOGS/planner-server.log"; return 1; }
    sleep 1
  done
  return 0
}
server_stop() {
  # kill by port owner (works on Windows where `kill $!` may target a wrapper)
  local pid
  pid="$(netstat -ano 2>/dev/null | awk -v p=":$PORT " '$4 ~ p && /LISTENING/ { print $5; exit }')"
  if [ -n "${pid:-}" ]; then
    taskkill //PID "$pid" //F > /dev/null 2>&1 || true
  fi
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  sleep 2
  # wait until the port is actually free
  local i=0
  while curl -sf "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; do
    i=$((i+1)); [ $i -ge 15 ] && { echo "warning: port $PORT still busy after stop"; break; }
    sleep 1
  done
  SERVER_PID=""
}

copy_db() { # $1=src $2=dest — consistent snapshot via SQLite online backup
  "$NODE" "$ROOT/scripts/copy-db.mjs" "$1" "$2" > /dev/null
}

overall=0

echo "== [1/6] build =="
(cd "$ROOT" && PATH="$NODE_DIR:$PATH" npm run build) > "$LOGS/planner-build.log" 2>&1
[ -f "$ROOT/dist/index.js" ] || { echo "build failed (see run/planner-build.log)"; tail -20 "$LOGS/planner-build.log"; exit 1; }
echo "build ok"

echo "== [2/6] copy staging -> test DB =="
copy_db "$STAGING_DB" "$TEST_DB"
export TEST_DB_PATH="$TEST_DB"

echo "== [3/6] main suite against :$PORT =="
server_start "$TEST_DB" || exit 1
"$NODE" "$ROOT/scripts/test-planner.mjs"
rc_main=$?
server_stop
[ $rc_main -ne 0 ] && overall=1

echo "== [4/6] seed gate phase A (no gate) =="
copy_db "$STAGING_DB" "$SEED_DB"
"$NODE" -e "
const Database = require('better-sqlite3');
const db = new Database(process.argv[1]);
db.exec(\`
  DELETE FROM task_runs; DELETE FROM account_cluster_members; DELETE FROM cluster_routines;
  DELETE FROM account_clusters; DELETE FROM warmup_sessions; DELETE FROM scan_sessions;
  DELETE FROM task_events; DELETE FROM notifications; DELETE FROM warmup_plan_days;
  DELETE FROM warmup_plan_items;
\`);
console.log('seed-test db prepared');
" "$SEED_DB"
export TEST_DB_PATH="$SEED_DB"
export PHASE=nogate
server_start "$SEED_DB" || exit 1
"$NODE" "$ROOT/scripts/test-planner-seed.mjs"
rc_nogate=$?
server_stop
[ $rc_nogate -ne 0 ] && overall=1

echo "== [5/6] seed gate phase B (SOUTHFARM_PLANNER_SEED=1) =="
export PHASE=gate
export SOUTHFARM_PLANNER_SEED=1
server_start "$SEED_DB" || exit 1
"$NODE" "$ROOT/scripts/test-planner-seed.mjs"
rc_gate=$?
server_stop
unset SOUTHFARM_PLANNER_SEED
[ $rc_gate -ne 0 ] && overall=1

echo ""
echo "############################################################"
echo "# RESULTS: main=$rc_main nogate=$rc_nogate gate=$rc_gate  #"
echo "############################################################"
exit $overall
