#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: tools/evidence.sh ASH-123 log|screenshot|recording source-file" >&2
  exit 2
fi
card="$1"
kind="$2"
source_file="$3"
if [[ ! "$card" =~ ^ASH-[0-9]{3}$ ]]; then echo "invalid card" >&2; exit 2; fi
case "$kind" in log|screenshot|recording) ;; *) echo "invalid evidence kind" >&2; exit 2;; esac
if [[ ! -f "$source_file" ]]; then echo "source must be a regular file" >&2; exit 2; fi
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target_dir="$repo_root/build/evidence/$card/$kind"
mkdir -p "$target_dir"
name="$(basename "$source_file")"
if [[ -e "$target_dir/$name" ]]; then echo "evidence already exists: build/evidence/$card/$kind/$name" >&2; exit 1; fi
cp -- "$source_file" "$target_dir/$name"
printf '%s\n' "build/evidence/$card/$kind/$name"
