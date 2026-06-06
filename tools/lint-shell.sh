#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if ! command -v shellcheck >/dev/null 2>&1; then
  echo "shellcheck is required. Install the dev lint tools documented in README.md." >&2
  exit 127
fi

candidates=()
if [ "$#" -gt 0 ]; then
  candidates=("$@")
else
  while IFS= read -r -d '' file; do
    candidates+=("$file")
  done < <(git ls-files -z)
fi

files=()
for file in "${candidates[@]}"; do
  [ -f "$file" ] || continue

  case "$file" in
    *.sh)
      files+=("$file")
      continue
      ;;
  esac

  first_line="$(head -n 1 "$file" || true)"
  case "$first_line" in
    '#!'*sh*) files+=("$file") ;;
  esac
done

[ "${#files[@]}" -gt 0 ] || exit 0

shellcheck -x \
  -P docker/cont-init.d \
  -P docker/s6/s6-rc.d/claude-auth \
  -P docker/s6/s6-rc.d/claude-worker \
  -P docker/s6/s6-rc.d/codex-auth \
  -P docker/s6/s6-rc.d/codex-worker \
  -P docker/s6/s6-rc.d/slack-bridge \
  "${files[@]}"
