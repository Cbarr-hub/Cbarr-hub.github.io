#!/usr/bin/env bash
# bgw-portforward.sh — add/inspect AT&T BGW210-700 port-forwards from the shell
# (no browser). Scripts the NAT/Gaming UI: create a Custom Service, then assign
# it to a device. The wire protocol was reverse-engineered in INFRA_LEGACY.md
# (recover from git history); this is the vendored, secret-free version first
# used to add the RLCraft :25566 forward (2026-06-16).
#
# USAGE
#   BGW_ACCESS_CODE=<code> tools/bgw-portforward.sh add  <name> <port[-port]> <device> [tcp|udp|both]
#   BGW_ACCESS_CODE=<code> tools/bgw-portforward.sh list
#
#   <device>  a MAC (aa:bb:cc:dd:ee:ff) OR a device-label substring, e.g. gamertown-docker
#   protocol  defaults to "both" (TCP/UDP)
#
# ENV
#   BGW_ACCESS_CODE  (required) the gateway "device access code" — the sticker on
#                    the BGW210. NEVER hardcode it; pass it inline per-invocation.
#   BGW_GATEWAY      gateway IP (default 192.168.1.254)
#
# EXAMPLE (the RLCraft forward)
#   BGW_ACCESS_CODE=xxxxxxxxxx tools/bgw-portforward.sh add RLCraft 25566 gamertown-docker both
#
# NOTES / gotchas baked in here:
#   * login auth = md5(accesscode + per-session nonce); password field = one '*'
#     per access-code char. A fresh nonce is pulled before EVERY POST.
#   * every POST answers 302 with a tiny body — we verify by RE-FETCHING the page.
#   * custom services appear in the assign dropdown as value "*<Name>"; an already
#     -assigned service drops OUT of that dropdown (that's the success signal).
#   * parsing stays mawk-safe (no gawk 3-arg match) via tr+grep+sed.
set -euo pipefail

BASE="http://${BGW_GATEWAY:-192.168.1.254}"
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
SID=''

die() { echo "ERROR: $*" >&2; exit 1; }
need_code() { [ -n "${BGW_ACCESS_CODE:-}" ] || die "set BGW_ACCESS_CODE (the gateway sticker access code)"; }

cj() { curl -s -A "$UA" -b "SessionID=$SID" "$@"; }              # authenticated GET/POST
get_nonce() { cj "$BASE$1" | grep -o 'name="nonce"[^>]*value="[^"]*"' \
                | sed -n 's/.*value="\([^"]*\)".*/\1/p' | head -1; }
# options come as: <option value="X"\n>text</option> — collapse newlines first
options() { tr '\n' ' ' < "$1" | grep -oE '<option value="[^"]*"[^>]*>[^<]*</option>'; }

login() {
  need_code
  SID=$(curl -s -i -A "$UA" "$BASE/cgi-bin/apphosting.ha" \
        | grep -i '^Set-Cookie:' | sed -n 's/.*SessionID=\([^;]*\).*/\1/p' | head -1)
  [ -n "$SID" ] || die "no SessionID from gateway (reachable? $BASE)"
  local n hash stars nsid
  n=$(get_nonce /cgi-bin/apphosting.ha); [ -n "$n" ] || die "no login nonce"
  hash=$(printf '%s' "${BGW_ACCESS_CODE}${n}" | md5sum | cut -d' ' -f1)
  stars=$(printf '%*s' "${#BGW_ACCESS_CODE}" '' | tr ' ' '*')
  nsid=$(curl -s -i -A "$UA" -b "SessionID=$SID" \
           --data-urlencode "nonce=$n" --data-urlencode "password=$stars" \
           --data-urlencode "hashpassword=$hash" --data-urlencode "Continue=Continue" \
           "$BASE/cgi-bin/login.ha" | grep -i '^Set-Cookie:' \
           | sed -n 's/.*SessionID=\([^;]*\).*/\1/p' | head -1)
  [ -n "$nsid" ] && SID="$nsid"
  # confirm we're past the login form
  cj "$BASE/cgi-bin/apphosting.ha" | grep -qi 'hashpassword' \
    && die "login failed (bad access code?)" || true
}

# resolve a device spec (MAC or label substring) to a MAC the gateway accepts
resolve_device() {
  local spec="$1" tmp; tmp=$(mktemp)
  if printf '%s' "$spec" | grep -qiE '^([0-9a-f]{2}:){5}[0-9a-f]{2}$'; then
    printf '%s' "$spec" | tr 'A-Z' 'a-z'; return 0
  fi
  cj "$BASE/cgi-bin/apphosting.ha" > "$tmp"
  local hit; hit=$(options "$tmp" | grep -iE "<option value=\"([0-9a-f]{2}:){5}[0-9a-f]{2}\"[^>]*>[^<]*${spec}" \
              | sed -E 's/.*value="([^"]*)".*/\1/' | sort -u)
  rm -f "$tmp"
  [ -n "$hit" ] || die "no device matching '$spec' in the gateway device list"
  [ "$(printf '%s\n' "$hit" | wc -l)" -eq 1 ] || die "device '$spec' is ambiguous:"$'\n'"$hit"
  printf '%s' "$hit"
}

cmd_add() {
  local name="$1" portspec="$2" devspec="$3" proto="${4:-both}"
  case "$proto" in tcp|udp|both) ;; *) die "protocol must be tcp|udp|both";; esac
  local pmin pmax
  if printf '%s' "$portspec" | grep -q '-'; then
    pmin="${portspec%-*}"; pmax="${portspec#*-}"
  else pmin="$portspec"; pmax="$portspec"; fi

  login
  local dev; dev=$(resolve_device "$devspec")
  echo "[*] gateway=$BASE  service='$name'  ext=$pmin-$pmax  proto=$proto  -> device=$dev"

  # guard against a duplicate service on these ports
  cj "$BASE/cgi-bin/services.ha" | grep -qE "(^|[^0-9])${pmin}([^0-9]|$)" \
    && die "a service referencing port $pmin already exists (refusing to duplicate)"

  # 1) create custom service
  local n; n=$(get_nonce /cgi-bin/services.ha)
  cj --data-urlencode "nonce=$n" --data-urlencode "Service=$name" \
     --data-urlencode "extMinPort=$pmin" --data-urlencode "extMaxPort=$pmax" \
     --data-urlencode "intStartPort=$pmin" --data-urlencode "protocol=$proto" \
     --data-urlencode "Add=Add" "$BASE/cgi-bin/services.ha" >/dev/null
  cj "$BASE/cgi-bin/services.ha" | grep -qiE "$name" \
    || die "service '$name' not present after create"
  echo "[ok] custom service created"

  # 2) assign to device — value is "*<name>" in the dropdown
  local tmp; tmp=$(mktemp); cj "$BASE/cgi-bin/apphosting.ha" > "$tmp"
  local svcval; svcval=$(options "$tmp" | grep -F "$name" | sed -E 's/.*value="([^"]*)".*/\1/' | head -1)
  rm -f "$tmp"
  [ -n "$svcval" ] || die "'$name' not in the assign dropdown after create"
  n=$(get_nonce /cgi-bin/apphosting.ha)
  cj --data-urlencode "nonce=$n" --data-urlencode "service=$svcval" \
     --data-urlencode "device=$dev" --data-urlencode "Add=Add" \
     "$BASE/cgi-bin/apphosting.ha" >/dev/null
  echo "[ok] assigned '$svcval' -> $dev"

  # 3) verify by re-fetch: service should be GONE from the add dropdown
  if cj "$BASE/cgi-bin/apphosting.ha" | tr '\n' ' ' \
       | grep -oE '<option value="[^"]*"[^>]*>[^<]*</option>' | grep -qF "$name"; then
    die "verification: '$name' still in add-dropdown — assignment did not take"
  fi
  echo "[OK] forward live: $name $pmin-$pmax/$proto -> $dev"
}

cmd_list() {
  login
  echo "== custom services =="
  cj "$BASE/cgi-bin/services.ha" | sed -E 's/<[^>]*>/ /g' | tr -s ' \t' ' ' \
    | grep -iE 'tcp|udp' | sed 's/^ //' | head -40
  echo "== hosted-application assignments =="
  cj "$BASE/cgi-bin/apphosting.ha" | tr '\n' ' ' | sed -E 's/<[^>]*>/ /g' | tr -s ' ' \
    | grep -oiE '[A-Za-z0-9 +-]+ TCP/UDP: [0-9,-]+ [A-Za-z0-9-]+' | head -40
}

case "${1:-}" in
  add)  shift; [ $# -ge 3 ] || die "usage: add <name> <port[-port]> <device> [tcp|udp|both]"; cmd_add "$@" ;;
  list) cmd_list ;;
  *)    sed -n '2,30p' "$0"; exit 1 ;;
esac
