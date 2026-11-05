#!/usr/bin/env bash
# Install or update the SSRL Beam Time calendar on the Rocky Linux 9 VM.
#
#   sudo bash install.sh        # first install, and again for every update
#
# What it does (idempotent):
#   1. preflight: tools, Python >= 3.9, outbound HTTPS to the SSRL schedule page
#   2. creates the system user `beamtime`
#   3. clones / fast-forwards the repo in /SSRL_LOCAL_OM/ssrl_beam_time_schedule, byte-compiles it
#   4. installs + (re)starts the systemd service `ssrl-beamtime` on 127.0.0.1:8010
#   5. installs the nginx location snippet as /etc/nginx/mail-in-xas.d/xray_schedule.conf
#      (included by the mail-in XAS portal's server block), runs `nginx -t` and reloads;
#      if the test fails the previous snippet is restored and the script stops
#   6. checks SELinux port labelling and the public paths through nginx
# It never edits the portal's nginx config and does not change SELinux settings itself.
set -euo pipefail

REPO_URL="https://github.com/slaclab/ssrl_beam_time_schedule.git"
APP_DIR="/SSRL_LOCAL_OM/ssrl_beam_time_schedule"
SVC_USER="beamtime"
SERVICE="ssrl-beamtime"
PORT=8010
URL_PATH="/mail-in-xas/xray_schedule"
NGINX_SNIPPET_DIR="/etc/nginx/mail-in-xas.d"
NGINX_SNIPPET="$NGINX_SNIPPET_DIR/xray_schedule.conf"
SOURCE_PAGE="https://www-ssrl.slac.stanford.edu/xray_schedule.html"

todo=()   # remaining manual steps, printed at the end
fail=0

[[ $EUID -eq 0 ]] || { echo "Run as root (sudo)." >&2; exit 1; }

echo "==> preflight"
for cmd in git python3 curl nginx; do
  command -v "$cmd" >/dev/null || { echo "Missing $cmd" >&2; exit 1; }
done
python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' \
  || { echo "Python >= 3.9 required" >&2; exit 1; }
echo "    $(python3 --version)"
if curl -fsSI --max-time 20 "$SOURCE_PAGE" -o /dev/null; then
  echo "    outbound HTTPS to the SSRL schedule page: OK"
else
  echo "    WARNING: cannot reach $SOURCE_PAGE; the service will start but has no data" >&2
  todo+=("Fix outbound HTTPS from this VM:  curl -sI $SOURCE_PAGE")
fi

echo "==> user"
id -u "$SVC_USER" &>/dev/null || useradd --system --no-create-home --shell /sbin/nologin "$SVC_USER"

echo "==> code"
# Run git as the owner of the checkout (it may have been cloned by a normal user;
# git refuses to work as root in a repo owned by someone else).
repo_git() {
  local owner; owner=$(stat -c %U "$APP_DIR")
  if [[ "$owner" == root ]]; then git -C "$APP_DIR" "$@"; else sudo -u "$owner" git -C "$APP_DIR" "$@"; fi
}
if [[ -d "$APP_DIR/.git" ]]; then
  repo_git pull --ff-only
else
  mkdir -p "$(dirname "$APP_DIR")"
  git clone "$REPO_URL" "$APP_DIR"
fi
install -d -o "$SVC_USER" -g "$SVC_USER" -m 755 "$APP_DIR/data"
if ! sudo -u "$SVC_USER" test -r "$APP_DIR/server.py"; then
  echo "ERROR: user $SVC_USER cannot read $APP_DIR/server.py; make $APP_DIR and its parent" \
       "directories world-readable/traversable (e.g. chmod o+rx)" >&2
  exit 1
fi
# Syntax check with the system Python; bytecode goes to a temp dir, not into the repo.
pyc_tmp=$(mktemp -d)
PYTHONPYCACHEPREFIX="$pyc_tmp" python3 -m py_compile "$APP_DIR"/*.py
rm -rf "$pyc_tmp"
echo "    $(repo_git log -1 --format='%h %s')"

echo "==> service"
install -m 644 "$APP_DIR/deploy/$SERVICE.service" "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
ok=""
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/schedule" -o /dev/null; then ok=1; break; fi
  sleep 1
done
if [[ -n "$ok" ]]; then
  echo "    service answers on 127.0.0.1:$PORT"
else
  echo "    ERROR: service not answering on 127.0.0.1:$PORT; see: journalctl -u $SERVICE -n 50" >&2
  fail=1
fi

echo "==> nginx"
src="$APP_DIR/deploy/nginx-xray_schedule.conf"
if [[ -f "$NGINX_SNIPPET" ]] && cmp -s "$src" "$NGINX_SNIPPET"; then
  echo "    $NGINX_SNIPPET unchanged"
else
  backup=""
  if [[ -f "$NGINX_SNIPPET" ]]; then
    backup=$(mktemp)
    cp -p "$NGINX_SNIPPET" "$backup"
  fi
  install -D -m 644 "$src" "$NGINX_SNIPPET"
  if command -v restorecon >/dev/null; then restorecon -R "$NGINX_SNIPPET_DIR"; fi
  if nginx -t; then
    systemctl reload nginx
    echo "    installed $NGINX_SNIPPET and reloaded nginx"
    if [[ -n "$backup" ]]; then rm -f "$backup"; fi
  else
    if [[ -n "$backup" ]]; then
      cp -p "$backup" "$NGINX_SNIPPET"; rm -f "$backup"
      echo "    ERROR: nginx -t failed; previous $NGINX_SNIPPET restored, nginx not reloaded" >&2
    else
      rm -f "$NGINX_SNIPPET"
      echo "    ERROR: nginx -t failed; $NGINX_SNIPPET removed, nginx not reloaded" >&2
    fi
    exit 1
  fi
fi
if ! grep -rqsF "$NGINX_SNIPPET_DIR/" /etc/nginx/nginx.conf /etc/nginx/conf.d/; then
  echo "    WARNING: no nginx config includes $NGINX_SNIPPET_DIR/*.conf yet; the snippet is inactive" >&2
  todo+=("The mail-in XAS portal's server block must contain:  include $NGINX_SNIPPET_DIR/*.conf;")
fi

echo "==> SELinux"
if command -v getenforce >/dev/null && [[ "$(getenforce)" == "Enforcing" ]]; then
  if ! command -v semanage >/dev/null; then
    echo "    semanage not found (dnf install policycoreutils-python-utils); cannot check port $PORT"
    todo+=("Allow nginx to connect to port $PORT:  semanage port -a -t http_port_t -p tcp $PORT   (use -m if already defined)")
  elif http_ports=$(semanage port -l | grep -E '^http_port_t\s+tcp\s' || true) \
       && grep -qw "$PORT" <<<"$http_ports"; then
    echo "    port $PORT is labelled http_port_t"
  else
    echo "    port $PORT is NOT labelled http_port_t; nginx will get 502 Bad Gateway"
    todo+=("Allow nginx to connect to port $PORT:  semanage port -a -t http_port_t -p tcp $PORT   (use -m if already defined)")
  fi
else
  echo "    not enforcing; nothing to check"
fi

echo "==> checks through nginx"
check() {  # name, expected, actual
  if [[ "$3" == "$2" ]]; then echo "    PASS  $1 ($3)"; else echo "    FAIL  $1: expected $2, got $3"; fail=1; fi
}
code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost$URL_PATH" || true)
check "$URL_PATH redirects" 301 "$code"
body=$(curl -s "http://localhost$URL_PATH/api/schedule" || true)
check "$URL_PATH/api/schedule returns JSON" "{" "${body:0:1}"
code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost/mail-in-xas/" || true)
check "/mail-in-xas/ portal unaffected" 200 "$code"

echo
if ((${#todo[@]})); then
  echo "==> remaining manual steps"
  for t in "${todo[@]}"; do echo "  * $t"; done
  echo "  then re-run this script to verify."
fi
if ((fail)); then
  echo "Finished with errors (see above)."
  exit 1
fi
echo "Done."
