#!/bin/sh
# Name: Remove Qiaomu Kindle
# Author: Qiaomu
set -eu
JOB=/etc/upstart/qiaomu-kindle.conf
SCANJOB=/etc/upstart/qiaomu-kindle-scan.conf
if [ -f "$JOB" ] && grep -q 'Qiaomu Kindle wireless receiver' "$JOB"; then
  stop qiaomu-kindle >/dev/null 2>&1 || true
  mntroot rw
  trap 'mntroot ro' EXIT HUP INT TERM
  rm "$JOB"
  if [ -f "$SCANJOB" ] && grep -q 'Qiaomu Kindle pending library scan' "$SCANJOB"; then rm "$SCANJOB"; fi
  mntroot ro
  trap - EXIT HUP INT TERM
  initctl reload-configuration
fi
printf '%s\n' '{"protocol":1,"port":2223,"prepared":true,"installed":false}' > /mnt/us/qiaomu-kindle/receiver.json
eips 0 2 'Receiver stopped. Books and keys preserved.' 2>/dev/null || true
