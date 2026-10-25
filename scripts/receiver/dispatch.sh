#!/bin/sh
# Accept only SFTP and two fixed protocol commands, never interpolated shell text.
set -eu
BASE=/mnt/us/qiaomu-kindle
case "${SSH_ORIGINAL_COMMAND:-}" in
  */sftp-server|sftp-server|internal-sftp)
    [ -d /mnt/us/documents ] || exit 1
    VARIANT=$(cat /var/local/qiaomu-kindle/variant)
    case "$VARIANT" in standard|recent) ;; *) exit 1 ;; esac
    exec "$BASE/bin/$VARIANT/sftp-server" -d /mnt/us/documents
    ;;
  qiaomu-receiver-v1)
    command -v lipc-set-prop >/dev/null
    printf '%s\n' '{"protocol":1,"scan":true}'
    ;;
  qiaomu-scan-v1)
    touch /var/local/qiaomu-kindle/scan.pending
    exec /bin/sh "$BASE/scan.sh"
    ;;
  *) exit 1 ;;
esac
