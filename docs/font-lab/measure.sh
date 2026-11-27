#!/bin/sh
# Compress each candidate alone at surprisal -1 and print raw and packed bytes. Archives go to ./packed/.
cd "$(dirname "$0")"
mkdir -p packed
S=/Volumes/Code/repos/surprisal/bin/surprisal
for f in out/empty.json out/*.json renderers/*.js; do
  echo "$(date +%T) $f"
  "$S" -1 -f -o "packed/$(basename "$f").13k" "$f" || echo "FAILED $f"
done
echo
printf '%-26s %8s %8s\n' file raw packed
for f in out/*.json renderers/*.js; do
  printf '%-26s %8d %8d\n' "$f" "$(wc -c < "$f")" "$(wc -c < "packed/$(basename "$f").13k")"
done | sort -u
echo "$(date +%T) done"
