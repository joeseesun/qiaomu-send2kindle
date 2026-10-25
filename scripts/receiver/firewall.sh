#!/bin/sh
# Only the dedicated receiver port on Wi-Fi; never flush device firewall rules.
set -eu
remove() {
  while iptables -D INPUT -j QIAOMU_KINDLE_IN 2>/dev/null; do :; done
  while iptables -D OUTPUT -j QIAOMU_KINDLE_OUT 2>/dev/null; do :; done
  for chain in QIAOMU_KINDLE_IN QIAOMU_KINDLE_OUT; do
    iptables -F "$chain" 2>/dev/null || true
    iptables -X "$chain" 2>/dev/null || true
  done
}
case "${1:-}" in
  start)
    remove
    iptables -N QIAOMU_KINDLE_IN
    iptables -N QIAOMU_KINDLE_OUT
    iptables -A QIAOMU_KINDLE_IN -i wlan0 -p tcp --dport 2223 -j ACCEPT
    iptables -A QIAOMU_KINDLE_OUT -o wlan0 -p tcp --sport 2223 -j ACCEPT
    iptables -I INPUT 1 -j QIAOMU_KINDLE_IN
    if ! iptables -I OUTPUT 1 -j QIAOMU_KINDLE_OUT; then remove; exit 1; fi
    ;;
  stop) remove ;;
  *) exit 1 ;;
esac
