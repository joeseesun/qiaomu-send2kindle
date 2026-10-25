#!/bin/sh
# One durable flag covers any number of received books; never re-send a book.
set -eu
PENDING=/var/local/qiaomu-kindle/scan.pending
[ -f "$PENDING" ] || exit 0
TRIES=1
[ "${1:-}" != retry ] || TRIES=3
while [ "$TRIES" -gt 0 ]; do
  if lipc-set-prop com.lab126.scanner doFullScan 1 >/dev/null 2>&1; then
    rm -f "$PENDING"
    printf '%s\n' scan-requested
    exit 0
  fi
  TRIES=$((TRIES - 1))
  [ "$TRIES" -eq 0 ] || sleep 1
done
printf '%s\n' scan-pending
