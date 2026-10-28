#!/bin/bash
# Part A suite for the OpenCode provider benchmark on hotcell Firecracker microVMs.
#
# Runs a list of (memoryMB:vCPU) guest configs, REPS times each, COLD (a fresh
# microVM per run — no reuse), and classifies every outcome so the memory ladder
# can't be confounded by non-memory failures:
#   PASS           typecheck succeeded (table shows the workload total)
#   OOM            typecheck died with the guest out of memory (min avail ~0 / SIGKILL)
#   INSTALL_FLAKE  bun install broke (node-gyp fallback / turbo missing) — network, not memory
#   ADMISSION      create refused (host capacity / 503) — itself a finding
#   OTHER          anything else (captured verbatim)
#
# It NEVER modifies dax's script and NEVER retries-until-green: every run's full
# raw stdout is saved and every rung's pass rate is reported as-is.
#
# Env:
#   CONFIGS   space list "MEM:CPU", e.g. "4096:8 6144:8 8192:8 12288:8 16384:8 32768:8"
#   REPS      runs per config (default 3)
#   EGRESS    1 = default-deny egress ON (HOTCELL_EGRESS_ENFORCE); default 0
#   ALLOWLIST_EXTRA   comma hosts added to the egress allowlist (Part A3 delta)
#   SKIP_BUILD 1 = skip git reset + npm build (box already built); default 0
#   REGION    label reported in the table (default gcp-n2-nested)
#   OUTDIR    where raw + summary land (default /tmp/bench-suite)
#   WARM_POOL_DEPTH  wait for this many ready spares before measuring (default 0)
#   BENCH_IMAGE image used by the benchmark sandbox (default ubuntu:24.04)
#   TURBO_CONCURRENCY maximum concurrent typecheck workers (default unlimited)
set +e
CONFIGS=${CONFIGS:-"24576:8"}
REPS=${REPS:-3}
EGRESS=${EGRESS:-0}
NETWORKED=${NETWORKED:-true}   # true = opt-in NAT (perf ladder); false = no NIC (Part A3 contained)
WRITABLE_ROOTFS=${WRITABLE_ROOTFS:-$NETWORKED}  # private rw rootfs; contained egress runs set true with NETWORKED=false
SKIP_BUILD=${SKIP_BUILD:-0}
REGION=${REGION:-gcp-n2-nested}
OUTDIR=${OUTDIR:-/tmp/bench-suite}
WARM_POOL_DEPTH=${WARM_POOL_DEPTH:-${HOTCELL_FC_WARM_POOL:-0}}
BENCH_IMAGE=${BENCH_IMAGE:-ubuntu:24.04}
TURBO_CONCURRENCY=${TURBO_CONCURRENCY:-}
mkdir -p "$OUTDIR"
SUMMARY="$OUTDIR/summary.tsv"
printf 'mem_mb\tcpus\trep\tresult\tclone_ms\tinstall_ms\ttypecheck_ms\ttotal_ms\tpeak_used_gib\tegress\n' > "$SUMMARY"
LOG(){ echo "[suite $(date -u +%H:%M:%S)] $*"; }

cd ~/hotcell 2>/dev/null || { cd ~; rm -rf hotcell; git clone -q https://github.com/directionally-local/hotcell.git; cd hotcell; }
if [ "$SKIP_BUILD" != 1 ]; then
  LOG "build"; git fetch -q origin main && git reset --hard -q origin/main
  npm install --no-audit --no-fund >/dev/null 2>&1; npm run build >/dev/null 2>&1
fi
mkdir -p helpers/hotcell-vz/guest
if [ ! -f "$HOME/hotcell-agent-linux-amd64" ]; then LOG "FATAL: $HOME/hotcell-agent-linux-amd64 missing"; exit 1; fi
cp "$HOME/hotcell-agent-linux-amd64" helpers/hotcell-vz/guest/hotcell-agent && chmod +x helpers/hotcell-vz/guest/hotcell-agent
if [ ! -f helpers/hotcell-vz/guest/vmlinux-fc ]; then
  latest=$(curl -s "http://spec.ccfc.min.s3.amazonaws.com/?prefix=firecracker-ci/v1.10/x86_64/vmlinux-5.10&list-type=2" | grep -oP "(?<=<Key>)(firecracker-ci/v1.10/x86_64/vmlinux-5\.10\.[0-9]+)(?=</Key>)" | sort -V | tail -1)
  curl -s -o helpers/hotcell-vz/guest/vmlinux-fc "https://s3.amazonaws.com/spec.ccfc.min/$latest"
fi
# Force one Ubuntu image re-convert so the node-gyp fidelity shim is baked in.
# Custom benchmark images should be rebuilt/invalidated by their image pipeline.
[ "$BENCH_IMAGE" = "ubuntu:24.04" ] && rm -f "$HOME/.hotcell/fc/images/ubuntu_24.04.img" 2>/dev/null
NODE=$(command -v node)

LOG "start daemon (egress=$EGRESS)"
sudo pkill -f "daemon/dist/index" 2>/dev/null; sleep 2
ENVX="HOTCELL_DRIVER=firecracker HOTCELL_DB=:memory: HOTCELL_FC_KERNEL=helpers/hotcell-vz/guest/vmlinux-fc HOTCELL_IMAGE=${BENCH_IMAGE}"
if [ "$WARM_POOL_DEPTH" -gt 0 ] 2>/dev/null; then
  ENVX="$ENVX HOTCELL_FC_WARM_POOL=${WARM_POOL_DEPTH}"
fi
if [ "$EGRESS" = 1 ]; then
  ENVX="$ENVX HOTCELL_EGRESS_ENFORCE=true HOTCELL_EGRESS_HOST=0.0.0.0"
  [ -n "$ALLOWLIST_EXTRA" ] && ENVX="$ENVX HOTCELL_ALLOWLIST_EXTRA=$ALLOWLIST_EXTRA"
fi
sudo -E env $ENVX setsid bash -c "$NODE packages/daemon/dist/index.js > /tmp/hotcelld.log 2>&1" </dev/null & disown
for i in $(seq 1 30); do curl -s --max-time 2 localhost:4750/healthz | grep -q ok && break; sleep 1; done
LOG "daemon: $(curl -s localhost:4750/healthz)"
if [ "$WARM_POOL_DEPTH" -gt 0 ] 2>/dev/null; then
  LOG "waiting for warm pool depth=$WARM_POOL_DEPTH"
  for i in $(seq 1 180); do
    POOL=$(curl -s --max-time 2 localhost:4750/capacity | $NODE -e '
      let d=""; process.stdin.on("data", c => d += c).on("end", () => {
        try { console.log(Number(JSON.parse(d).pool?.spares ?? 0)); } catch { console.log(0); }
      });')
    [ "${POOL:-0}" -ge "$WARM_POOL_DEPTH" ] 2>/dev/null && break
    sleep 1
  done
  POOL=$(curl -s --max-time 2 localhost:4750/capacity)
  echo "WARM_POOL_READY depth=${WARM_POOL_DEPTH} capacity=${POOL}"
fi

# stage dax's script + the mem-sampling wrapper once (base64, decoded into each guest)
PB64=$(curl -fsSL "https://raw.githubusercontent.com/anomalyco/opencode/provider-benchmark/script/provider-benchmark.sh" | base64 -w0)
RB64=$(base64 -w0 "$(dirname "$0")/runbench.sh")

# --max-time bounds every exec so a stalled guest drops that rep instead of wedging
# the whole suite (900s >> a healthy rung's ~2-4 min, even at 2 vCPU).
exj(){ curl -s --max-time 900 -N -X POST "localhost:4750/sandboxes/$1/exec" -H 'content-type: application/json' -d "$2" | sed -n 's/^data: //p' | $NODE -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{d.trim().split("\n").forEach(l=>{try{let e=JSON.parse(l);if(e.type=="stdout"||e.type=="stderr")process.stdout.write(e.data)}catch{}})})'; }
field(){ awk -v k="$2" '$1=="BENCH_PHASE"&&$2==k{print $3} $1=="BENCH_MEM"&&$2=="peak_used_gib"&&k=="peak"{print $3}' "$1" | tail -1; }

classify(){ # raw-file -> RESULT
  local f="$1"
  grep -qE '✅ \|[[:space:]]*$' "$f" && { echo PASS; return; }
  grep -qE 'ADMISSION|CREATE_FAILED|503' "$f" && { echo ADMISSION; return; }
  grep -qE 'node-gyp ENOENT|Cannot run .*turbo\.json|install script from .* exited' "$f" && { echo INSTALL_FLAKE; return; }
  grep -qE 'BENCH_MEM[[:space:]]+cgroup_oom_kill[[:space:]]+[1-9]' "$f" && { echo OOM; return; }
  local minav; minav=$(awk '$1=="BENCH_MEM"&&$2=="min_avail_kib"{print $3}' "$f" | tail -1)
  { grep -qiE 'SIGKILL|Out of memory|oom-kill|Killed process|Cannot allocate' "$f"; } && { echo OOM; return; }
  [ -n "$minav" ] && [ "$minav" -lt 262144 ] 2>/dev/null && { echo OOM; return; }
  echo OTHER
}

# Pre-warm the OCI->rootfs conversion (needs docker), then stop dockerd so its
# iptables chains don't pollute the measured FC NAT path (perf mode; EGRESS=0 only).
LOG "pre-warming image conversion (ubuntu:24.04 -> FC rootfs)"
  WRESP=$(curl -s --max-time 180 -X POST localhost:4750/sandboxes -H 'content-type: application/json' -d "{\"image\":\"${BENCH_IMAGE}\",\"driver\":\"firecracker\",\"networked\":${NETWORKED},\"writableRootfs\":${WRITABLE_ROOTFS},\"memoryMb\":2048,\"cpus\":2,\"cpuset\":\"0-1\"}")
WSB=$(echo "$WRESP" | $NODE -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).id||"ERR")}catch{console.log("ERR")}})')
LOG "  warmup sandbox=$WSB"; sleep 2; curl -s -X DELETE "localhost:4750/sandboxes/$WSB" >/dev/null 2>&1
if [ "$EGRESS" != 1 ] && [ -f "$HOME/.hotcell/fc/images/ubuntu_24.04.img" ]; then
  LOG "stopping dockerd (image cached; removes iptables noise from measured runs)"
  systemctl stop docker docker.socket 2>/dev/null; sleep 1
fi

for cfg in $CONFIGS; do
  MEM=${cfg%%:*}; CPUS=${cfg##*:}
  CPUSET="0-$((CPUS-1))"   # physical cores (no SMT siblings): CCD0 for <=8, both CCDs at 16
  for REP in $(seq 1 "$REPS"); do
    tag="mem${MEM}_cpu${CPUS}_r${REP}"; raw="$OUTDIR/$tag.txt"
    LOG "RUN $tag (cpuset=$CPUSET networked=$NETWORKED)"
    {
      echo "### CONFIG mem=${MEM}MB cpus=${CPUS} cpuset=${CPUSET} networked=${NETWORKED} writableRootfs=${WRITABLE_ROOTFS} turboConcurrency=${TURBO_CONCURRENCY:-unlimited} rep=${REP} egress=${EGRESS} region=${REGION} image=${BENCH_IMAGE} $(date -u +%FT%TZ)"
      RESP=$(curl -s --max-time 180 -X POST localhost:4750/sandboxes -H 'content-type: application/json' -d "{\"image\":\"${BENCH_IMAGE}\",\"driver\":\"firecracker\",\"networked\":${NETWORKED},\"writableRootfs\":${WRITABLE_ROOTFS},\"memoryMb\":${MEM},\"cpus\":${CPUS},\"cpuset\":\"${CPUSET}\"}")
      SB=$(echo "$RESP" | $NODE -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).id||("ERR:"+d))}catch{console.log("ERR:"+d)}})')
      echo "sandbox=$SB"
      if echo "$SB" | grep -qE '^ERR|^$'; then
        echo "CREATE_FAILED $RESP"; tail -25 /tmp/hotcelld.log
      else
        FCPID=$(pgrep -x firecracker | tail -1)
        [ -n "$FCPID" ] && echo "fc_pin: cpus_allowed=$(awk '/Cpus_allowed_list/{print $2}' /proc/$FCPID/status 2>/dev/null) requested=${CPUSET}"
        exj "$SB" '{"command":"echo mem=$(awk \"/MemTotal/{printf \\$2}\" /proc/meminfo)kib cpus=$(nproc); getent hosts registry.npmjs.org >/dev/null 2>&1 && echo DNS_OK || echo DNS_FAIL"}'
        exj "$SB" "{\"command\":\"echo $PB64 | base64 -d > /tmp/pb.sh; echo $RB64 | base64 -d > /tmp/runbench.sh; chmod +x /tmp/runbench.sh\"}"
        echo "############### BENCHMARK (${MEM}MB/${CPUS}cpu rep${REP}) ###############"
      exj "$SB" "{\"command\":\"TURBO_CONCURRENCY=${TURBO_CONCURRENCY} BENCH_REGION=${REGION} bash /tmp/runbench.sh\"}"
        echo "############### END ###############"
        curl -s -X DELETE "localhost:4750/sandboxes/$SB" >/dev/null 2>&1
      fi
    } > "$raw" 2>&1
    RES=$(classify "$raw")
    CL=$(field "$raw" clone); IN=$(field "$raw" install); TC=$(field "$raw" typecheck); TT=$(field "$raw" total); PK=$(awk '$1=="BENCH_MEM"&&$2=="peak_used_gib"{print $3}' "$raw" | tail -1)
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$MEM" "$CPUS" "$REP" "$RES" "${CL:-}" "${IN:-}" "${TC:-}" "${TT:-}" "${PK:-}" "$EGRESS" >> "$SUMMARY"
    LOG "  -> $RES (clone=${CL:-?}ms install=${IN:-?}ms typecheck=${TC:-?}ms peak=${PK:-?}GiB)"
  done
done
LOG "SUITE COMPLETE -> $SUMMARY"
echo "=== SUMMARY ==="; cat "$SUMMARY"
echo SUITEDONE
