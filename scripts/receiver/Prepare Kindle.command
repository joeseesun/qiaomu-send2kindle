#!/bin/sh
set -eu
BASE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec python3 "$BASE/prepare.py" /Volumes/Kindle
