#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage: sudo ./install-beta9.sh /absolute/path/hydro-league-agent-0.1.0.tgz

Environment overrides:
  HYDRO_HOME          Hydro data directory (default: /root/.hydro)
  HYDRO_PM2_PROCESS   PM2 process name (default: hydrooj)
  HYDRO_HEALTH_URL    Local health URL (default: http://127.0.0.1:8888/)
  HYDRO_LEAGUE_AGENT_SHA256
                      Expected package SHA-256 (defaults to the official 0.1.0 asset)

This installer targets the standard root-owned Hydro 5.0.0-beta.9 + PM2 layout.
It does not change Hydro plugin configuration. Review the site configuration
supplied by the league organizer before enabling a new installation.
EOF
}

if [ "$#" -ne 1 ]; then
  usage >&2
  exit 2
fi
if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo 'Run this installer as root.' >&2
  exit 1
fi

archive=$(realpath -e -- "$1")
hydro_home=${HYDRO_HOME:-/root/.hydro}
pm2_process=${HYDRO_PM2_PROCESS:-hydrooj}
health_url=${HYDRO_HEALTH_URL:-http://127.0.0.1:8888/}
expected_sha256=${HYDRO_LEAGUE_AGENT_SHA256:-9cbfa9563f21a2a225128927bb340925733ad971a7ce4499f217bf48debabd6d}

case "$hydro_home" in
  /*) ;;
  *)
    echo 'HYDRO_HOME must be an absolute path.' >&2
    exit 1
    ;;
esac
hydro_home=$(realpath -m -- "$hydro_home")
if [ "$hydro_home" = / ]; then
  echo 'HYDRO_HOME cannot be the filesystem root.' >&2
  exit 1
fi

addon_file="$hydro_home/addon.json"
addon_root="$hydro_home/addons"
destination="$addon_root/hydro-league-agent"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$hydro_home/backups/hydro-league-agent-$stamp"
staging="$addon_root/.hydro-league-agent-staging-$stamp"

for command in node hydrooj pm2 curl tar sha256sum; do
  command -v "$command" >/dev/null || {
    echo "Required command is missing: $command" >&2
    exit 1
  }
done

if [[ ! "$expected_sha256" =~ ^[[:xdigit:]]{64}$ ]]; then
  echo 'HYDRO_LEAGUE_AGENT_SHA256 must be exactly 64 hexadecimal characters.' >&2
  exit 1
fi
read -r actual_sha256 _ < <(sha256sum "$archive")
if [ "${actual_sha256,,}" != "${expected_sha256,,}" ]; then
  echo "Package SHA-256 mismatch: expected $expected_sha256, received $actual_sha256." >&2
  exit 1
fi

hydro_cli=$(realpath -e -- "$(command -v hydrooj)")
host_hydro_version=$(
  node - "$hydro_cli" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

let current = path.dirname(process.argv[2]);
while (true) {
  const packageFile = path.join(current, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    if (pkg.name === 'hydrooj') {
      process.stdout.write(String(pkg.version));
      process.exit(0);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const parent = path.dirname(current);
  if (parent === current) process.exit(1);
  current = parent;
}
NODE
)
if [ "$host_hydro_version" != '5.0.0-beta.9' ]; then
  echo "Expected hydrooj@5.0.0-beta.9, found hydrooj@$host_hydro_version." >&2
  exit 1
fi

test -f "$addon_file"
mkdir -p "$addon_root" "$hydro_home/backups"
install -d -m 700 "$backup"
cp -a "$addon_file" "$backup/addon.json"
sha256sum "$archive" > "$backup/archive.sha256"
if [ -e "$destination" ]; then cp -a "$destination" "$backup/addon-before"; fi

rollback() {
  code=$?
  trap - ERR INT TERM HUP
  set +e
  rm -rf -- "$staging" "$destination"
  if [ -e "$backup/addon-before" ]; then cp -a "$backup/addon-before" "$destination"; fi
  cp -a "$backup/addon.json" "$addon_file"
  pm2 restart "$pm2_process" --update-env >/dev/null 2>&1
  echo "Install failed; restored the previous addon state from $backup" >&2
  exit "$code"
}
trap rollback ERR INT TERM HUP

mkdir -m 700 "$staging"
tar -xzf "$archive" -C "$staging" --strip-components=1
for required in \
  index.js \
  dist/index.js \
  package.json \
  npm-shrinkwrap.json \
  templates/league-xcpcio.html \
  templates/league-realboard.html \
  public/hydro-league-xcpcio/index.html \
  public/hydro-league-agent-source.zip; do
  test -f "$staging/$required"
done

node - "$staging/package.json" <<'NODE'
const pkg = require(process.argv[2]);
if (pkg.name !== 'hydro-league-agent' || pkg.version !== '0.1.0') {
  throw new Error(`Unexpected package: ${pkg.name}@${pkg.version}`);
}
if (pkg.peerDependencies?.hydrooj !== '5.0.0-beta.9') {
  throw new Error('This package does not target hydrooj@5.0.0-beta.9');
}
NODE

test -d "$staging/node_modules/schemastery"
test -d "$staging/node_modules/@react-spring/web"
test ! -e "$staging/node_modules/hydrooj"
test ! -e "$staging/node_modules/react"
test ! -e "$staging/node_modules/react-dom"

rm -rf -- "$destination"
mv "$staging" "$destination"
chown -R root:root "$destination"

if ! node - "$addon_file" "$destination" <<'NODE'
const fs = require('fs');
const addons = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.exit(addons.includes(process.argv[3]) ? 0 : 1);
NODE
then
  hydrooj addon add "$destination"
fi

node - "$addon_file" "$destination" <<'NODE'
const fs = require('fs');
const addons = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const count = addons.filter((entry) => entry === process.argv[3]).length;
if (count !== 1) throw new Error(`Expected one addon registration, received ${count}`);
NODE

old_pid=$(pm2 pid "$pm2_process" | tail -n 1)
pm2 restart "$pm2_process" --update-env >/dev/null
healthy=0
for _ in $(seq 1 60); do
  new_pid=$(pm2 pid "$pm2_process" | tail -n 1)
  if [ "$new_pid" != 0 ] && [ "$new_pid" != "$old_pid" ] \
    && curl -fsS --max-time 3 "$health_url" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
test "$healthy" = 1

trap - ERR INT TERM HUP
cat <<EOF
Hydro League Agent 0.1.0 installed successfully.
Addon directory: $destination
Backup directory: $backup
The installer did not change the Hydro plugin configuration. Review it before use.
EOF
