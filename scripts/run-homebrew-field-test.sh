#!/bin/bash
set -Eeuo pipefail

kit=/private/tmp/gattini-homebrew-field-test-20260928
tap=gattini/local-test
formula=$tap/gattini
archive=gattini-0.2.0.tgz
state="$kit/state with spaces"
tap_owned=0
daemon_pid=
completed=0

if [[ ! -f "$kit/MANIFEST.sha256" || ! -f "$kit/$archive" ]]; then
  echo "Extract the test bundle into $kit before running this script." >&2
  exit 1
fi

run_dir=$(mktemp -d "$kit/run.XXXXXX")
exec > >(tee "$run_dir/console.log") 2>&1

if [[ -n "${GATTINI_FIELD_DISPOSABLE_BREW:-}" ]]; then
  brew_command=$GATTINI_FIELD_DISPOSABLE_BREW
  disposable=1
else
  brew_command=brew
  disposable=0
fi

stop_daemon() {
  if [[ -n "$daemon_pid" ]]; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
    daemon_pid=
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ "$completed" -ne 1 ]]; then
    status=1
  fi
  stop_daemon
  if [[ "$tap_owned" -eq 1 ]]; then
    if "$brew_command" list --formula --versions gattini >/dev/null 2>&1; then
      "$brew_command" uninstall --formula --force "$formula" || status=1
    fi
    if "$brew_command" tap | grep -Fxq "$tap"; then
      "$brew_command" untap "$tap" || status=1
    fi
  fi
  if [[ "$status" -ne 0 ]]; then
    echo "FAILED. Gattini cleanup was attempted. Keep $run_dir/console.log for diagnosis."
  fi
  exit "$status"
}
trap cleanup EXIT

echo "Gattini Homebrew field test; log: $run_dir/console.log"
[[ $(uname -s) == Darwin && $(uname -m) == arm64 ]] || {
  echo "This package supports Apple Silicon Macs only; no installation was attempted." >&2
  exit 1
}
command -v "$brew_command" >/dev/null || {
  echo "Homebrew is required on this Mac; no installation was attempted." >&2
  exit 1
}
prefix=$("$brew_command" --prefix)
if [[ "$disposable" -eq 1 ]]; then
  [[ "$prefix" == /private/tmp/* ]] || {
    echo "Disposable rehearsal requires a /private/tmp Homebrew prefix." >&2
    exit 1
  }
else
  [[ "$prefix" == /opt/homebrew ]] || {
    echo "Expected Apple Silicon Homebrew at /opt/homebrew; found $prefix." >&2
    exit 1
  }
fi

echo "macOS: $(sw_vers -productVersion); CPU: $(uname -m)"
brew_version=$("$brew_command" --version)
echo "$brew_version"
echo "Homebrew prefix: $prefix"
if "$brew_command" list --formula --versions gattini >/dev/null 2>&1; then
  echo "Gattini is already installed. No changes were made." >&2
  exit 1
fi
if "$brew_command" tap | grep -Fxq "$tap"; then
  echo "The test tap already exists. No changes were made." >&2
  exit 1
fi
node_before=$("$brew_command" list --versions node@24 2>/dev/null || true)
echo "Node 24 before: $node_before"

(cd "$kit" && shasum -a 256 -c MANIFEST.sha256)
git -C "$kit/tap-source" status --porcelain
[[ -z $(git -C "$kit/tap-source" status --porcelain) ]] || {
  echo "The local tap has changed since packaging." >&2
  exit 1
}

tap_owned=1
"$brew_command" tap "$tap" "$kit/tap-source"
if [[ "$disposable" -eq 1 ]]; then
  "$brew_command" install --formula --ignore-dependencies "$formula"
else
  "$brew_command" install --formula "$formula"
fi
"$brew_command" list --formula --versions "$formula"
HOMEBREW_DEVELOPER=1 "$brew_command" test "$formula"

mkdir -p "$state"
chmod 700 "$state"
printf 'Offline Homebrew field test\n' > "$run_dir/task with spaces.txt"
GATTINI_STATE_DIR="$state" "$prefix/bin/gattinid" > "$run_dir/daemon.out" 2> "$run_dir/daemon.err" &
daemon_pid=$!
ready=0
for ((attempt = 0; attempt < 100; attempt++)); do
  if [[ -S "$state/gattinid.sock" ]]; then
    ready=1
    break
  fi
  sleep 0.1
done
[[ "$ready" -eq 1 ]] || {
  echo "Daemon did not create its socket. See $run_dir/daemon.err." >&2
  exit 1
}

GATTINI_STATE_DIR="$state" "$prefix/bin/gattini" run \
  --task-file "$run_dir/task with spaces.txt" \
  --idempotency-key "field-test-$(basename "$run_dir")" \
  --role code --json > "$run_dir/run.json"
node_bin="$("$brew_command" --prefix node@24)/bin/node"
job_id=$("$node_bin" -e 'const fs=require("fs");const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(r.state!=="completed"||r.result?.acceptance!=="unverified")process.exit(1);process.stdout.write(r.jobId)' "$run_dir/run.json")
GATTINI_STATE_DIR="$state" "$prefix/bin/gattini" status "$job_id" --json > "$run_dir/status.json"
GATTINI_STATE_DIR="$state" "$prefix/bin/gattini" result "$job_id" --json > "$run_dir/result.json"
GATTINI_STATE_DIR="$state" "$prefix/bin/gattini" events "$job_id" \
  --after-sequence 0 --limit 100 --json > "$run_dir/events.json"
"$node_bin" -e 'const fs=require("fs"),assert=require("assert/strict"),p=process.argv[1],id=process.argv[2];const read=n=>JSON.parse(fs.readFileSync(`${p}/${n}.json`,"utf8"));assert.equal(read("status").state,"completed");assert.equal(read("result").jobId,id);assert.deepEqual(read("events").events.map(e=>e.sequence),[1,2,3])' "$run_dir" "$job_id"
stop_daemon

database="$state/jobs.sqlite"
[[ -f "$database" ]] || {
  echo "The durable job database is missing." >&2
  exit 1
}
database_before=$(shasum -a 256 "$database" | awk '{print $1}')
"$brew_command" uninstall --formula --force "$formula"
"$brew_command" untap "$tap"
tap_owned=0
if "$brew_command" list --formula --versions gattini >/dev/null 2>&1; then
  echo "Homebrew still lists Gattini after uninstall." >&2
  exit 1
fi
if "$brew_command" tap | grep -Fxq "$tap"; then
  echo "The local test tap remains after untap." >&2
  exit 1
fi
[[ ! -e "$prefix/bin/gattini" && ! -e "$prefix/bin/gattinid" ]] || {
  echo "Gattini commands remain after uninstall." >&2
  exit 1
}
database_after=$(shasum -a 256 "$database" | awk '{print $1}')
[[ "$database_before" == "$database_after" ]] || {
  echo "The job database changed during uninstall." >&2
  exit 1
}

node_after=$("$brew_command" list --versions node@24 2>/dev/null || true)
echo "Node 24 after: $node_after"
echo "PASS: brew install, brew test, fake job, status/result/events, brew uninstall, and state preservation."
echo "GATTINI_FIELD_JOB_ID=$job_id"
echo "GATTINI_FIELD_DATABASE_SHA256=$database_after"
"$node_bin" -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({status:"passed",platform:process.platform,arch:process.arch,macOS:process.argv[2],homebrewVersion:process.argv[3],homebrewPrefix:process.argv[4],node24Before:process.argv[5],node24After:process.argv[6],archiveSha256:process.argv[7],jobId:process.argv[8],eventSequences:[1,2,3],databaseSha256:process.argv[9],formulaTestPassed:true,statePreserved:true,gattiniLeftInstalled:false,testTapRemoved:true,providerCalls:0,serviceRegistration:false},null,2)+"\n")' \
  "$kit/report.json" "$(sw_vers -productVersion)" "$brew_version" "$prefix" \
  "$node_before" "$node_after" "$(shasum -a 256 "$kit/$archive" | awk '{print $1}')" \
  "$job_id" "$database_after"
echo "Report: $kit/report.json"
completed=1
