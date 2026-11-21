#!/usr/bin/env bash
# Plays test talks through the real app (capture worklet -> engine -> Output) and scores each run.
# Usage: tools/follow/run-live.sh <out-dir> <talk> [talk...]     e.g. run-live.sh .dev/live3 t1-verbatim t3-skip
# Windows open on screen while it runs: don't touch them.
set -u
cd "$(dirname "$0")/../.."
out=$1; shift
for t in "$@"; do
  d="$out/$t"; rm -rf "$d"; mkdir -p "$d"
  dur=$(node -e "console.log(Math.ceil(require('./.dev/talks/$t.json').duration*1000)+2500)")
  TP_FOLLOW_FAKEMIC=${FAKEMIC:-1} TP_SNAPSHOT="$(pwd -W)/$d" TP_FOLLOW_WAV="$(pwd -W)/.dev/talks/$t.wav" \
  TP_ACTIONS='[{"a":"speakerFile","file":"2_Sample_Talk.txt"},{"a":"home"},{"a":"followOn"}]' \
  TP_WAIT=$dur timeout $(( dur / 1000 + 90 )) npx electron . > "$d/stdout.txt" 2>&1
  node tools/follow/eval-run.js "$d/follow-log.json"
done
