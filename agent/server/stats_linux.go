//go:build linux

package server

import (
	"bufio"
	"os"
	"runtime"
	"strconv"
	"strings"

	"github.com/directionally-local/hotcell/agent/proto"
)

// readStats reads the guest's resource usage from /proc and the cgroup
// filesystem — the in-VM analogue of the container driver's Docker stats call.
// Cumulative counters (CPU ns, net bytes) are returned raw; the host's existing
// metrics sampler integrates the deltas, so the shape matches SandboxStats
// exactly and capacity/cost code stays unchanged.
//
// Note: cpuPercent is left 0 here — it's an instantaneous rate the host derives
// from successive cpuTotalUsageNs samples (as the container driver does from
// precpu), so the guest only needs to report the cumulative counter.
func readStats() proto.SandboxStats {
	s := proto.SandboxStats{
		OnlineCPUs: numCPU(),
	}
	s.CPUTotalUsageNs = cpuTotalNs()
	s.MemBytes, s.MemLimitBytes = memStats()
	s.NetRxBytes, s.NetTxBytes = netStats()
	s.Pids = countPids()
	return s
}

func numCPU() int {
	// Online CPUs as seen by the guest kernel.
	data, err := os.ReadFile("/sys/devices/system/cpu/online")
	if err == nil {
		if n := parseCPURange(strings.TrimSpace(string(data))); n > 0 {
			return n
		}
	}
	return runtime.NumCPU()
}

func parseCPURange(s string) int {
	// e.g. "0-3" or "0-1,3"
	total := 0
	for _, part := range strings.Split(s, ",") {
		if part == "" {
			continue
		}
		if lo, hi, ok := strings.Cut(part, "-"); ok {
			a, _ := strconv.Atoi(lo)
			b, _ := strconv.Atoi(hi)
			if b >= a {
				total += b - a + 1
			}
		} else {
			total++
		}
	}
	return total
}

// cpuTotalNs reads cumulative CPU usage. Prefer cgroup v2 cpu.stat (usage_usec),
// falling back to /proc/stat aggregate jiffies.
func cpuTotalNs() uint64 {
	if f, err := os.Open("/sys/fs/cgroup/cpu.stat"); err == nil {
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			fields := strings.Fields(sc.Text())
			if len(fields) == 2 && fields[0] == "usage_usec" {
				if usec, err := strconv.ParseUint(fields[1], 10, 64); err == nil {
					return usec * 1000 // µs → ns
				}
			}
		}
	}
	// Fallback: /proc/stat "cpu" line, in USER_HZ jiffies (assume 100 Hz).
	if data, err := os.ReadFile("/proc/stat"); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "cpu ") {
				var sum uint64
				for _, tok := range strings.Fields(line)[1:] {
					v, _ := strconv.ParseUint(tok, 10, 64)
					sum += v
				}
				return sum * 10_000_000 // jiffies (1/100s) → ns
			}
		}
	}
	return 0
}

// memStats returns resident bytes and the memory limit from cgroup v2.
func memStats() (used, limit uint64) {
	if data, err := os.ReadFile("/sys/fs/cgroup/memory.current"); err == nil {
		used, _ = strconv.ParseUint(strings.TrimSpace(string(data)), 10, 64)
	}
	if data, err := os.ReadFile("/sys/fs/cgroup/memory.max"); err == nil {
		txt := strings.TrimSpace(string(data))
		if txt != "max" {
			limit, _ = strconv.ParseUint(txt, 10, 64)
		}
	}
	if used == 0 {
		// Fallback to /proc/meminfo (MemTotal-MemAvailable) when cgroup files
		// aren't present (rare on a VZ/FC guest, but be defensive).
		total, avail := meminfo()
		if total > avail {
			used = total - avail
		}
		if limit == 0 {
			limit = total
		}
	}
	return used, limit
}

func meminfo() (total, avail uint64) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		kb, _ := strconv.ParseUint(fields[1], 10, 64)
		switch fields[0] {
		case "MemTotal:":
			total = kb * 1024
		case "MemAvailable:":
			avail = kb * 1024
		}
	}
	return total, avail
}

// netStats sums rx/tx bytes across interfaces (excluding loopback) from
// /proc/net/dev.
func netStats() (rx, tx uint64) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		iface, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue // header lines
		}
		if strings.TrimSpace(iface) == "lo" {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 9 {
			continue
		}
		r, _ := strconv.ParseUint(fields[0], 10, 64)  // rx bytes
		t, _ := strconv.ParseUint(fields[8], 10, 64)  // tx bytes
		rx += r
		tx += t
	}
	return rx, tx
}

// countPids counts process entries under /proc.
func countPids() int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range entries {
		if _, err := strconv.Atoi(e.Name()); err == nil {
			n++
		}
	}
	return n
}
