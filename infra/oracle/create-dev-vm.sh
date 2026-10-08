#!/usr/bin/env bash
# Creates the Craftoria dev VM on Oracle Cloud Always Free with the OCI CLI.
# FREE TIER ONLY: it creates only Always-Free-eligible resources and refuses to start if CPU, memory
# or disk would go beyond the Always Free limits (4 OCPU / 24 GB RAM / 200 GB storage for Ampere A1).
#
# Best run in OCI Cloud Shell (console → top-right ">_" icon): already logged in, `oci` preinstalled.
# Also works anywhere the OCI CLI is configured (`oci setup config`), e.g. Git Bash or WSL.
#
# Usage:
#   export SSH_PUBLIC_KEY="ssh-ed25519 AAAA... craftoria-dev"   # contents of your .pub file
#   bash create-dev-vm.sh
#
# Optional settings (environment variables):
#   COMPARTMENT_ID   default: your tenancy (root compartment)
#   NAME             default: craftoria-dev
#   OCPUS            default: 2          MEMORY_GB  default: 12       BOOT_GB default: 100
#   CLOUD_INIT       default: cloud-init.dev.yaml next to this script
#   RETRY_MINUTES    default: 5 (wait between "out of capacity" / "too many requests" rounds)
#   MAX_ROUNDS       default: 24 (24 × 5 min = 2 hours of retrying)
#   DRY_RUN=1        only look things up and print the plan; create nothing
#
# Safe to re-run: existing network pieces and an existing instance with the same name are reused.

set -euo pipefail

NAME=${NAME:-craftoria-dev}
OCPUS=${OCPUS:-2}
MEMORY_GB=${MEMORY_GB:-12}
BOOT_GB=${BOOT_GB:-100}
RETRY_MINUTES=${RETRY_MINUTES:-5}
MAX_ROUNDS=${MAX_ROUNDS:-24}
DRY_RUN=${DRY_RUN:-0}
SHAPE=VM.Standard.A1.Flex
FREE_A1_OCPUS=4
FREE_A1_MEMORY_GB=24
FREE_BLOCK_STORAGE_GB=200 # Always Free: boot + block volumes combined
VCN_NAME=craftoria-vcn
IGW_NAME=craftoria-igw
SUBNET_NAME=craftoria-public

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLOUD_INIT=${CLOUD_INIT:-$here/cloud-init.dev.yaml}

log() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

# --- preflight ------------------------------------------------------------------

command -v oci >/dev/null || die "OCI CLI not found. Run this in OCI Cloud Shell, or install the CLI and run 'oci setup config'."
[ -f "$CLOUD_INIT" ] || die "cloud-init file not found: $CLOUD_INIT (upload cloud-init.dev.yaml next to this script)."

if [ -z "${SSH_PUBLIC_KEY:-}" ]; then
  die "Set SSH_PUBLIC_KEY to the contents of your public key, e.g.
  export SSH_PUBLIC_KEY=\"\$(cat ~/.ssh/craftoria-dev.pub)\"   # or paste it in quotes"
fi
case "$SSH_PUBLIC_KEY" in
  ssh-ed25519\ * | ssh-rsa\ * | ecdsa-sha2-*) ;;
  *) die "SSH_PUBLIC_KEY doesn't look like a public key (should start with ssh-ed25519 or ssh-rsa). Never paste the private key." ;;
esac
pubkey_file=$(mktemp)
trap 'rm -f "$pubkey_file"' EXIT
printf '%s\n' "$SSH_PUBLIC_KEY" >"$pubkey_file"

if [ -z "${COMPARTMENT_ID:-}" ]; then
  if [ -n "${OCI_TENANCY:-}" ]; then
    COMPARTMENT_ID=$OCI_TENANCY
  elif [ -f "$HOME/.oci/config" ]; then
    COMPARTMENT_ID=$(sed -n 's/^tenancy *= *//p' "$HOME/.oci/config" | head -n1)
  fi
fi
[ -n "${COMPARTMENT_ID:-}" ] || die "Couldn't find your tenancy OCID. Console → Profile (top right) → Tenancy → copy OCID, then: export COMPARTMENT_ID=ocid1.tenancy..."

C=$COMPARTMENT_ID
log "Compartment: $C"

# --- free-tier guard ---------------------------------------------------------------

log "Checking existing Ampere A1 usage (free limit: $FREE_A1_OCPUS OCPU / $FREE_A1_MEMORY_GB GB)"
existing_id=$(oci compute instance list -c "$C" --display-name "$NAME" --all \
  --query "data[?\"lifecycle-state\"!='TERMINATED' && \"lifecycle-state\"!='TERMINATING'] | [0].id" --raw-output 2>/dev/null || true)
[ "$existing_id" = "null" ] && existing_id=""

used_ocpus=$(oci compute instance list -c "$C" --all \
  --query "sum(data[?shape=='$SHAPE' && \"lifecycle-state\"!='TERMINATED' && \"lifecycle-state\"!='TERMINATING'].\"shape-config\".ocpus)" \
  --raw-output 2>/dev/null || echo 0)
used_mem=$(oci compute instance list -c "$C" --all \
  --query "sum(data[?shape=='$SHAPE' && \"lifecycle-state\"!='TERMINATED' && \"lifecycle-state\"!='TERMINATING'].\"shape-config\".\"memory-in-gbs\")" \
  --raw-output 2>/dev/null || echo 0)
used_ocpus=${used_ocpus%.*}
used_mem=${used_mem%.*}
info "A1 already in use: ${used_ocpus:-0} OCPU / ${used_mem:-0} GB"

if [ -z "$existing_id" ]; then
  if [ $((${used_ocpus:-0} + OCPUS)) -gt $FREE_A1_OCPUS ] || [ $((${used_mem:-0} + MEMORY_GB)) -gt $FREE_A1_MEMORY_GB ]; then
    die "Creating $OCPUS OCPU / $MEMORY_GB GB would exceed the Always Free A1 limit. Nothing was created."
  fi
fi

# boot volumes (per availability domain) + block volumes count toward the 200 GB Always Free storage
ads=$(oci iam availability-domain list -c "$C" --query "join(' ', data[].name)" --raw-output)
used_storage=0
for ad in $ads; do
  n=$(oci bv boot-volume list -c "$C" --availability-domain "$ad" --all     --query "sum(data[?\"lifecycle-state\"!='TERMINATED' && \"lifecycle-state\"!='TERMINATING'].\"size-in-gbs\")"     --raw-output 2>/dev/null || echo 0)
  n=${n%.*}
  used_storage=$((used_storage + ${n:-0}))
done
n=$(oci bv volume list -c "$C" --all   --query "sum(data[?\"lifecycle-state\"!='TERMINATED' && \"lifecycle-state\"!='TERMINATING'].\"size-in-gbs\")"   --raw-output 2>/dev/null || echo 0)
n=${n%.*}
used_storage=$((used_storage + ${n:-0}))
info "Block storage already in use: ${used_storage} GB of ${FREE_BLOCK_STORAGE_GB} GB"
free_storage=$((FREE_BLOCK_STORAGE_GB - used_storage))
if [ -z "$existing_id" ] && [ $((used_storage + BOOT_GB)) -gt $FREE_BLOCK_STORAGE_GB ]; then
  if [ "$free_storage" -ge 47 ]; then
    die "A ${BOOT_GB} GB boot disk would exceed the Always Free ${FREE_BLOCK_STORAGE_GB} GB storage. Nothing was created. Rerun with BOOT_GB=${free_storage}."
  fi
  die "Only ${free_storage} GB of Always Free storage is left (a boot disk needs at least 47 GB). Nothing was created. Delete unused boot/block volumes in the console first."
fi
[ "$BOOT_GB" -ge 47 ] || die "BOOT_GB must be at least 47 (Oracle's minimum boot volume)."

# --- image --------------------------------------------------------------------------

log "Finding the latest Canonical Ubuntu 24.04 image for $SHAPE (ARM)"
image_id=$(oci compute image list -c "$C" --operating-system "Canonical Ubuntu" --operating-system-version "24.04" \
  --shape "$SHAPE" --sort-by TIMECREATED --sort-order DESC --all \
  --query 'data[?!contains("display-name",`Minimal`)] | [0].id' --raw-output)
[ -n "$image_id" ] && [ "$image_id" != "null" ] || die "No Ubuntu 24.04 ARM image found in this region."
image_name=$(oci compute image get --image-id "$image_id" --query 'data."display-name"' --raw-output)
info "$image_name"

info "Availability domains: $ads"

if [ "$DRY_RUN" = "1" ]; then
  log "DRY RUN: would create $NAME ($SHAPE, $OCPUS OCPU, $MEMORY_GB GB, ${BOOT_GB} GB disk) in: $ads"
  [ -n "$existing_id" ] && info "An instance named $NAME already exists: $existing_id"
  exit 0
fi

# --- network (reused if it exists) ---------------------------------------------------------

lookup() { # lookup <oci network subcommand...> → first matching id or empty
  local id
  id=$("$@" --query "data[?\"lifecycle-state\"=='AVAILABLE'] | [0].id" --raw-output 2>/dev/null || true)
  [ "$id" = "null" ] && id=""
  printf '%s' "$id"
}

log "Network"
vcn_id=$(lookup oci network vcn list -c "$C" --display-name "$VCN_NAME" --all)
if [ -z "$vcn_id" ]; then
  vcn_id=$(oci network vcn create -c "$C" --display-name "$VCN_NAME" --cidr-blocks '["10.0.0.0/16"]' \
    --dns-label craftoria --wait-for-state AVAILABLE --query 'data.id' --raw-output)
  info "created VCN $VCN_NAME"
else
  info "reusing VCN $VCN_NAME"
fi

igw_id=$(lookup oci network internet-gateway list -c "$C" --vcn-id "$vcn_id" --display-name "$IGW_NAME" --all)
if [ -z "$igw_id" ]; then
  igw_id=$(oci network internet-gateway create -c "$C" --vcn-id "$vcn_id" --display-name "$IGW_NAME" \
    --is-enabled true --wait-for-state AVAILABLE --query 'data.id' --raw-output)
  info "created internet gateway"
else
  info "reusing internet gateway"
fi

rt_id=$(oci network vcn get --vcn-id "$vcn_id" --query 'data."default-route-table-id"' --raw-output)
oci network route-table update --rt-id "$rt_id" --force \
  --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$igw_id\"}]" \
  --wait-for-state AVAILABLE >/dev/null
info "default route → internet gateway"
# The VCN's default security list allows SSH (TCP 22) from anywhere and ICMP; nothing else is opened.

subnet_id=$(lookup oci network subnet list -c "$C" --vcn-id "$vcn_id" --display-name "$SUBNET_NAME" --all)
if [ -z "$subnet_id" ]; then
  subnet_id=$(oci network subnet create -c "$C" --vcn-id "$vcn_id" --display-name "$SUBNET_NAME" \
    --cidr-block 10.0.0.0/24 --dns-label public --prohibit-public-ip-on-vnic false \
    --wait-for-state AVAILABLE --query 'data.id' --raw-output)
  info "created public subnet"
else
  info "reusing public subnet"
fi

# --- instance (retries across ADs on "out of capacity") ----------------------------------------

if [ -n "$existing_id" ]; then
  log "Instance $NAME already exists; skipping launch"
  instance_id=$existing_id
else
  instance_id=""
  for round in $(seq 1 "$MAX_ROUNDS"); do
    for ad in $ads; do
      log "Launching $NAME in $ad (round $round/$MAX_ROUNDS)"
      set +e
      out=$(oci compute instance launch -c "$C" --availability-domain "$ad" --display-name "$NAME" \
        --shape "$SHAPE" --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEMORY_GB}" \
        --image-id "$image_id" --boot-volume-size-in-gbs "$BOOT_GB" \
        --subnet-id "$subnet_id" --assign-public-ip true \
        --ssh-authorized-keys-file "$pubkey_file" --user-data-file "$CLOUD_INIT" \
        --wait-for-state RUNNING --max-wait-seconds 900 --query 'data.id' --raw-output 2>&1)
      status=$?
      set -e
      if [ $status -eq 0 ]; then
        instance_id=$(printf '%s\n' "$out" | grep -o 'ocid1\.instance[^" ]*' | tail -n1)
        break 2
      fi
      if printf '%s' "$out" | grep -qiE 'out of (host )?capacity|InternalError|TooManyRequests|"status": 429'; then
        info "no free ARM capacity in $ad right now (Oracle says busy); will retry"
        continue
      fi
      printf '%s\n' "$out" >&2
      die "Launch failed for a reason other than capacity (see above). Nothing else was changed."
    done
    if [ "$round" -lt "$MAX_ROUNDS" ]; then
      info "No capacity anywhere right now. Waiting $RETRY_MINUTES minutes ($(date '+%H:%M') now; Ctrl+C to stop, rerunning later is safe)."
      sleep $((RETRY_MINUTES * 60))
    fi
  done
  [ -n "$instance_id" ] || die "Still out of capacity after $MAX_ROUNDS rounds. Try again later, or OCPUS=1 MEMORY_GB=6 (resize later)."
fi

public_ip=$(oci compute instance list-vnics --instance-id "$instance_id" --query 'data[0]."public-ip"' --raw-output)

log "Done"
info "Instance:  $NAME"
info "Public IP: $public_ip"
cat <<EOF

Next, on your Windows laptop:

1) Add this to  %USERPROFILE%\\.ssh\\config  (create the file if missing):

Host $NAME
    HostName $public_ip
    User ubuntu
    IdentityFile ~/.ssh/craftoria-dev
    ServerAliveInterval 30

2) In PowerShell:   ssh $NAME
   then on the VM:  cloud-init status --wait      (5–10 min on first boot; must end with "done")
   then:            exit   and   ssh $NAME   again (applies the docker group)

3) Continue with Part D of infra/oracle/DEV-VM-SETUP.md (VS Code Remote-SSH).
EOF
