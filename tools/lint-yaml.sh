#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if ! command -v yamllint >/dev/null 2>&1; then
  echo "yamllint is required. Install the dev lint tools documented in README.md." >&2
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
    *.yml|*.yaml) files+=("$file") ;;
  esac
done

[ "${#files[@]}" -gt 0 ] || exit 0

yamllint -s "${files[@]}"
