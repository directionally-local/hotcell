package server

import (
	"os"
	"path/filepath"

	"github.com/directionally-local/hotcell/agent/proto"
)

// ReseedResult reports what a `reseed` request actually changed. The host logs
// it and the fork path treats a partial result as non-fatal (a guest without
// /etc/machine-id is unusual but not broken).
type ReseedResult struct {
	Hostname     string `json:"hostname,omitempty"`
	MachineID    string `json:"machineId,omitempty"`
	ClockSet     bool   `json:"clockSet"`
	EntropyBytes int    `json:"entropyBytes"`
}

// handleReseed gives a snapshot-restored clone a fresh identity.
//
// A Firecracker snapshot captures guest RAM, so every clone restored from one
// template starts with the *same* hostname, machine-id, wall clock and — most
// importantly — the same kernel CRNG state. Two clones that share a CRNG can
// predict each other's random numbers, which is a real (if subtle) break of
// isolation. The host therefore calls this once per fork, before the sandbox is
// handed to the caller.
func (a *Agent) handleReseed(w *proto.FrameWriter, id uint32, req proto.Request) {
	res, err := reseedGuest(req.Hostname, req.MachineID, req.UnixTime, req.EntropyBytes)
	if err != nil {
		writeError(w, id, "reseed: "+err.Error())
		return
	}
	writeResult(w, id, proto.Result{OK: true, Value: res})
}

// writeIdentityFiles persists the clone's new identity where userland reads it.
// Split out from the syscalls so it is testable on any platform (the agent only
// ever runs in a Linux guest, but `go test ./...` runs on the developer's Mac).
//
// `root` is the filesystem prefix ("/" in a guest, a temp dir in tests). Missing
// parent directories are created; a failure to write one file is reported but
// does not stop the others, since the syscall-level identity (hostname) is what
// actually matters for isolation.
func writeIdentityFiles(root, hostname, machineID string) error {
	var firstErr error
	keep := func(err error) {
		if err != nil && firstErr == nil {
			firstErr = err
		}
	}
	if hostname != "" {
		keep(writeFileIfDir(filepath.Join(root, "etc"), "hostname", hostname+"\n"))
	}
	if machineID != "" {
		keep(writeFileIfDir(filepath.Join(root, "etc"), "machine-id", machineID+"\n"))
		// dbus reads its own copy when present; keep the two consistent.
		dbusDir := filepath.Join(root, "var", "lib", "dbus")
		if st, err := os.Stat(dbusDir); err == nil && st.IsDir() {
			keep(writeFileIfDir(dbusDir, "machine-id", machineID+"\n"))
		}
	}
	return firstErr
}

// writeFileIfDir writes `name` inside `dir` only when `dir` already exists, so a
// minimal guest without /etc (or without dbus) is left alone rather than having
// directories invented for it.
func writeFileIfDir(dir, name, content string) error {
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return nil
	}
	return os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644)
}
