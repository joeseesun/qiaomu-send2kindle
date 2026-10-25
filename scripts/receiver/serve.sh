#!/bin/sh
set -eu
BASE=/mnt/us/qiaomu-kindle
STATE=/var/local/qiaomu-kindle
[ -d /mnt/us/documents ] || exit 1
[ -s /mnt/us/usbnetlite/etc/dropbear/authorized_keys ] || exit 1
VARIANT=$(cat "$STATE/variant")
case "$VARIANT" in standard|recent) ;; *) exit 1 ;; esac
exec "$BASE/bin/$VARIANT/dropbearmulti" dropbear -R -F -s -j -k -P /var/run/qiaomu-kindle.pid -p 2223 -c "/bin/sh $BASE/dispatch.sh"
