#!/usr/bin/env bash
# Run on the dev VM after first boot:  bash ~/code/Handicarft-Store/infra/oracle/verify-dev-vm.sh
# Prints PASS/FAIL for everything the Craftoria dev workflow needs.
set -u

pass=0
fail=0
check() {
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then
    echo "PASS  $name"
    pass=$((pass + 1))
  else
    echo "FAIL  $name"
    fail=$((fail + 1))
  fi
}

check "cloud-init finished"            test -f /var/log/craftoria-ready
check "architecture is arm64"          bash -c '[ "$(uname -m)" = "aarch64" ]'
check "docker engine running"          docker info
check "docker usable without sudo"     docker ps
check "docker compose plugin"          docker compose version
check "docker can run a container"     docker run --rm hello-world
check "node 24 or newer"               bash -c '[ "$(node -p "process.versions.node.split(\".\")[0]")" -ge 24 ]'
check "pnpm 10"                        bash -c 'pnpm -v | grep -q "^10\."'
check "git installed"                  git --version
check "swap enabled"                   bash -c '[ "$(swapon --show --noheadings | wc -l)" -ge 1 ]'
check "at least 8 GB RAM"              bash -c '[ "$(free -g | awk "/Mem:/ {print \$2}")" -ge 8 ]'
check "at least 20 GB disk free"       bash -c '[ "$(df -BG --output=avail / | tail -1 | tr -dc 0-9)" -ge 20 ]'
check "postgres image runs on arm64"   docker run --rm postgres:17-alpine postgres --version
check "rabbitmq image pulls on arm64"  docker pull rabbitmq:4-management-alpine

echo
echo "$pass passed, $fail failed"
if [ "$fail" -gt 0 ]; then
  echo "Hint: if 'docker usable without sudo' failed, log out and back in once (group membership), then rerun."
  exit 1
fi
