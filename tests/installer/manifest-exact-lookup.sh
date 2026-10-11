#!/usr/bin/env bash
# (Verify Boss VB-04): a manifest path is matched EXACTLY, never as a substring. forge_manifest_lookup_hash
# used grep -F "rel<TAB>", so looking up a.md could return the hash recorded for dir/a.md. The retired-file
# pruning's "still shipped" check did the same, so an old a.md counted as shipped whenever dir/a.md was, and was
# never retired. Loads the REAL installer functions (install.sh without its final `main` call) into this shell.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

sed '$d' "$REPO/install.sh" > "$WORK/funcs.sh"
set +eu
# shellcheck source=/dev/null
source "$WORK/funcs.sh"
set -eu

h1=$(printf 'a%.0s' $(seq 1 64)); h2=$(printf 'b%.0s' $(seq 1 64))

# 1. the lookup returns the hash of the exact path, not of a longer path that merely ends with it
printf 'dir/a.md\t%s\na.md\t%s\n' "$h1" "$h2" > "$WORK/old.tsv"
got=$(forge_manifest_lookup_hash "$WORK/old.tsv" "a.md")
[ "$got" = "$h2" ] && ok "1: a.md gets its own hash, not dir/a.md's" || bad "1: a.md got '$got' (expected its own hash)"
got=$(forge_manifest_lookup_hash "$WORK/old.tsv" "dir/a.md")
[ "$got" = "$h1" ] && ok "1: dir/a.md gets its own hash" || bad "1: dir/a.md got '$got'"
got=$(forge_manifest_lookup_hash "$WORK/old.tsv" "b.md")
[ -z "$got" ] && ok "1: a path that is not listed gets no hash" || bad "1: b.md got '$got'"
got=$(forge_manifest_lookup_hash "$WORK/old.tsv" ".md")
[ -z "$got" ] && ok "1: a suffix of a listed path gets no hash" || bad "1: .md got '$got'"

# 1b. a number-like path is compared as a string: awk compares numeric-looking fields as numbers
printf '01\twrong\n1\tright\n' > "$WORK/num.tsv"
got=$(forge_manifest_lookup_hash "$WORK/num.tsv" "1")
[ "$got" = "right" ] && ok "1b: the path 1 does not match the row 01" || bad "1b: the path 1 got '$got' (a numeric comparison matched 01)"
got=$(forge_manifest_lookup_hash "$WORK/num.tsv" "1.0")
[ -z "$got" ] && ok "1b: the path 1.0 matches nothing" || bad "1b: the path 1.0 got '$got'"

# 2. pruning: an old a.md is retired when only dir/a.md is still shipped
ROOT="$WORK/root"; mkdir -p "$ROOT/dir"
printf 'forge wrote this\n' > "$ROOT/a.md"
printf 'still shipped\n' > "$ROOT/dir/a.md"
HA=$(forge_sha256 "$ROOT/a.md"); HD=$(forge_sha256 "$ROOT/dir/a.md")
printf 'a.md\t%s\ndir/a.md\t%s\n' "$HA" "$HD" > "$WORK/old2.tsv"
printf 'dir/a.md\t%s\n' "$HD" > "$WORK/new2.tsv"
forge_prune_retired_manifest_files "$ROOT" "$WORK/old2.tsv" "$WORK/new2.tsv" "$WORK/backup" 0 >/dev/null
[ ! -e "$ROOT/a.md" ] && [ -f "$WORK/backup/a.md" ] && ok "2: the old a.md is retired into the backup folder" || bad "2: the old a.md was not retired (it counted as shipped because dir/a.md is)"
[ -f "$ROOT/dir/a.md" ] && ok "2: dir/a.md, still shipped, stays in place" || bad "2: dir/a.md was moved"
[ "${FORGE_LAST_RETIRED:-}" = "1" ] && ok "2: exactly one file retired" || bad "2: retired count is '${FORGE_LAST_RETIRED:-}'"

# 3. the pruning's temp files live in the installer's own scratch dir ($MANIFEST_TMP, which the
#    installer's exit trap removes), so an error exit halfway through leaves nothing behind outside it
MT="$WORK/mt"; mkdir -p "$MT"; ROOT3="$WORK/root3"; mkdir -p "$ROOT3"
printf 'x\n' > "$ROOT3/x.md"; HX=$(forge_sha256 "$ROOT3/x.md")
printf 'x.md\t%s\n' "$HX" > "$WORK/old3.tsv"; printf 'y.md\t%s\n' "$HX" > "$WORK/new3.tsv"
( MANIFEST_TMP="$MT"; cut() { exit 1; }; forge_prune_retired_manifest_files "$ROOT3" "$WORK/old3.tsv" "$WORK/new3.tsv" "$WORK/backup3" 0 >/dev/null 2>&1 ) || true
n=$(find "$MT" -type f | wc -l | tr -d ' ')
[ "$n" -ge 1 ] && ok "3: after a failure mid-way the pruning's temp file is inside the managed scratch dir" || bad "3: the pruning's temp file was not created in \$MANIFEST_TMP (found $n)"

exit "$fail"
