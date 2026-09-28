#!/bin/sh
set -eu

if [ "$#" -ne 3 ] || [ "$(uname -s)" != Linux ]; then
  echo "Usage (on Linux): sh scripts/verify-linux-xdg-smoke.sh ARCHIVE WORK_DIR SUMMARY_JSON" >&2
  exit 2
fi

archive=$1
work=$2
summary=$3
case "$archive:$work:$summary" in
  /*:/*:/*) ;;
  *) echo "All paths must be absolute" >&2; exit 2 ;;
esac
if [ -e "$work" ] || [ -e "$summary" ]; then
  echo "Work directory and summary must not already exist" >&2
  exit 2
fi

mkdir -p "$work"
tar -xzf "$archive" -C "$work"
cli="$work/package/dist/src/cli/gattini.js"
daemon="$work/package/dist/src/daemon/gattinid.js"
task="$work/task with spaces.txt"
printf 'Offline Linux XDG smoke task.\n' > "$task"
unset GATTINI_STATE_DIR
export XDG_STATE_HOME="$work/xdg state"
socket="$XDG_STATE_HOME/gattini/gattinid.sock"
pid=

stop_daemon() {
  if [ -n "$pid" ]; then
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    pid=
  fi
}
trap 'stop_daemon' EXIT HUP INT TERM

start_daemon() {
  node "$daemon" > "$work/daemon.log" 2>&1 &
  pid=$!
  count=0
  until [ -S "$socket" ]; do
    count=$((count + 1))
    if [ "$count" -ge 100 ] || ! kill -0 "$pid" 2>/dev/null; then
      cat "$work/daemon.log" >&2
      echo "Daemon did not create its XDG socket" >&2
      exit 1
    fi
    sleep 0.1
  done
}

start_daemon
node "$cli" run --task-file "$task" --idempotency-key linux-xdg-smoke --json > "$work/run.json"
job_id=$(node -e 'const fs = require("node:fs"); const row = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (row.state !== "completed" || typeof row.jobId !== "string") process.exit(1); console.log(row.jobId)' "$work/run.json")
node "$cli" events "$job_id" --after-sequence 0 --limit 1 --json > "$work/first-events.json"
stop_daemon
start_daemon
node "$cli" status "$job_id" --json > "$work/status-after-restart.json"
node "$cli" events "$job_id" --after-sequence 1 --limit 100 --json > "$work/events-after-restart.json"
node "$cli" result "$job_id" --json > "$work/result-after-restart.json"
node -e '
  const fs = require("node:fs");
  const assert = require("node:assert/strict");
  const path = require("node:path");
  const work = process.argv[1], jobId = process.argv[2], summary = process.argv[3];
  const read = name => JSON.parse(fs.readFileSync(path.join(work, name), "utf8"));
  const first = read("first-events.json"), later = read("events-after-restart.json");
  const status = read("status-after-restart.json"), result = read("result-after-restart.json");
  assert.equal(status.jobId, jobId);
  assert.equal(status.state, "completed");
  assert.equal(result.jobId, jobId);
  assert.deepEqual(first.events.map(event => event.sequence), [1]);
  assert.deepEqual(later.events.map(event => event.sequence), [2, 3]);
  assert.equal(later.hasMore, false);
  const report = { platform: process.platform, arch: process.arch, jobId,
    xdgStateHome: process.env.XDG_STATE_HOME, statusAfterRestart: status.state,
    eventSequences: [1, 2, 3], resultRecovered: true };
  fs.writeFileSync(summary, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(report));
' "$work" "$job_id" "$summary"
stop_daemon
