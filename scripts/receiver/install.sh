#!/bin/sh
# Name: Install Qiaomu Kindle
# Author: Qiaomu
set -eu
BASE=/mnt/us/qiaomu-kindle
STATE=/var/local/qiaomu-kindle
fail() { echo "$1"; eips 0 3 "$1" 2>/dev/null || true; exit 1; }
[ "$(id -u)" = 0 ] || fail 'Jailbreak root access required.'
[ -s /mnt/us/usbnetlite/etc/dropbear/authorized_keys ] || fail 'Pair over USB in Qiaomu Reader first.'
[ -d /etc/upstart ] || fail 'Unsupported Kindle startup system.'
command -v lipc-set-prop >/dev/null || fail 'Kindle library service unavailable.'
command -v iptables >/dev/null || fail 'Kindle Wi-Fi firewall unavailable.'
mkdir -p "$STATE"
VARIANT=
for v in standard recent; do
  chmod 755 "$BASE/bin/$v/dropbearmulti" "$BASE/bin/$v/sftp-server"
  if "$BASE/bin/$v/dropbearmulti" dropbear -V 2>&1 | grep -q Dropbear; then VARIANT=$v; break; fi
done
[ -n "$VARIANT" ] || fail 'Unsupported Kindle CPU or firmware.'
printf '%s\n' "$VARIANT" > "$STATE/variant"
chmod 700 "$STATE"
# This upstream multi-call build excludes dropbearkey. The server's -R option
# generates its standard host keys on first connection and preserves existing keys.
JOB=/etc/upstart/qiaomu-kindle.conf
SCANJOB=/etc/upstart/qiaomu-kindle-scan.conf
if [ ! -e "$JOB" ] && netstat -lnt 2>/dev/null | grep -q ':2223 '; then fail 'Port 2223 is already in use.'; fi
if [ -e "$JOB" ] && ! grep -q 'Qiaomu Kindle wireless receiver' "$JOB"; then fail 'Existing startup job was preserved.'; fi
if [ -e "$SCANJOB" ] && ! grep -q 'Qiaomu Kindle pending library scan' "$SCANJOB"; then fail 'Existing scan job was preserved.'; fi
mntroot rw
trap 'mntroot ro' EXIT HUP INT TERM
cp "$BASE/qiaomu-kindle.conf" "$JOB"
cp "$BASE/qiaomu-kindle-scan.conf" "$SCANJOB"
mntroot ro
trap - EXIT HUP INT TERM
initctl reload-configuration
stop qiaomu-kindle >/dev/null 2>&1 || true
start qiaomu-kindle
sleep 1
status qiaomu-kindle | grep -q 'start/running' || fail 'Receiver did not start. Keep KOReader mode.'
/bin/sh "$BASE/scan.sh" retry >/dev/null
printf '%s\n' '{"protocol":1,"port":2223,"prepared":true,"installed":true}' > "$BASE/receiver.json"
eips 0 2 'Qiaomu receiver installed. Connect Wi-Fi.' 2>/dev/null || true
eips 0 4 'KOReader is not required for native books.' 2>/dev/null || true
