#!/bin/sh
set -eu

if test "$#" -ne 1; then
  echo "Usage: sh scripts/build-homebrew-field-kit.sh ABS_RELEASE_DIR" >&2
  exit 2
fi
release_dir=$1
case "$release_dir" in
  /*) ;;
  *) echo "Release directory must be absolute" >&2; exit 2 ;;
esac

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
kit=/private/tmp/gattini-homebrew-field-test-20260928
zip=$kit.zip
if test -e "$kit" || test -e "$zip"; then
  echo "Refusing to replace an existing field kit: $kit or $zip" >&2
  exit 1
fi
archive=$release_dir/gattini-0.2.0.tgz
release_json=$release_dir/release.json
test -f "$archive" && test -f "$release_json"
(cd "$release_dir" && shasum -a 256 -c gattini-0.2.0.tgz.sha256)

mkdir -p "$kit/tap-source/Formula"
cp "$archive" "$kit/gattini-0.2.0.tgz"
cp "$release_dir/gattini-0.2.0.tgz.sha256" "$kit/gattini-0.2.0.tgz.sha256"
cp "$release_json" "$kit/release.json"
cp "$repo/scripts/run-homebrew-field-test.sh" "$kit/test-homebrew.sh"
chmod 755 "$kit/test-homebrew.sh"
node "$repo/scripts/render-homebrew-formula.mjs" \
  --release-json "$kit/release.json" \
  --archive "$kit/gattini-0.2.0.tgz" \
  --url "file://$kit/gattini-0.2.0.tgz" \
  --homepage https://example.com/gattini \
  --out "$kit/tap-source/Formula/gattini.rb"
ruby -c "$kit/tap-source/Formula/gattini.rb"
git -C "$kit/tap-source" init -q
git -C "$kit/tap-source" add Formula/gattini.rb
git -C "$kit/tap-source" -c user.name=GattiniTest -c user.email=gattini-test@example.invalid commit -qm 'Local macOS ARM field-test formula'

cat > "$kit/README-FIRST.txt" <<'EOF'
Gattini 0.2.0 Homebrew field test for an Apple Silicon Mac

1. Copy this ZIP to the Mac you want to test. It needs Homebrew and internet
   access for Homebrew's Node 24 dependency if Node 24 is not already installed.
2. In Terminal, extract the ZIP to /private/tmp. Use your actual ZIP location:

     ditto -xk /path/to/gattini-homebrew-field-test-20260928.zip /private/tmp

3. Run:

     bash /private/tmp/gattini-homebrew-field-test-20260928/test-homebrew.sh

The script checks the package, installs Gattini through a local Homebrew tap,
runs the formula test and an offline fake job, then uninstalls Gattini and
removes the test tap. It leaves its disposable job data and logs under this
folder for inspection. It does not start a login service or call a provider.
If Homebrew installs Node 24 and its dependencies, they may remain afterward;
the script does not remove shared dependencies. On failure it attempts to
remove Gattini and the test tap, and keeps a console log for diagnosis.

If the script prints PASS, send back report.json from this folder. The report
has platform, versions, hashes and a fake job ID; no provider content.
EOF

(cd "$kit" && shasum -a 256 \
  gattini-0.2.0.tgz \
  gattini-0.2.0.tgz.sha256 \
  release.json \
  tap-source/Formula/gattini.rb \
  test-homebrew.sh \
  README-FIRST.txt > MANIFEST.sha256)
(cd /private/tmp && zip -q -r -X "$zip" "$(basename "$kit")")
shasum -a 256 "$zip" > "$zip.sha256"
echo "Field kit: $zip"
cat "$zip.sha256"
