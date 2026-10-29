//go:build linux

package server

import (
	"errors"
	"testing"

	"golang.org/x/sys/unix"
)

// addEntropy is the security-critical half of a fork: clones restored from one
// snapshot share the template's CRNG state, so each must mix in fresh host
// entropy. In a guest the agent is PID 1 (root) and this succeeds; an
// unprivileged host (CI) can't issue RNDADDENTROPY, so skip there.
func TestAddEntropy(t *testing.T) {
	n, err := addEntropy(32)
	if err != nil {
		if errors.Is(err, unix.EPERM) {
			t.Skip("unprivileged: RNDADDENTROPY needs CAP_SYS_ADMIN")
		}
		t.Fatalf("addEntropy: %v", err)
	}
	if n != 32 {
		t.Errorf("credited %d bytes, want 32", n)
	}
}

// A zero/oversized request is clamped to the pool-info buffer size.
func TestAddEntropyClamps(t *testing.T) {
	n, err := addEntropy(0)
	if err != nil {
		if errors.Is(err, unix.EPERM) {
			t.Skip("unprivileged: RNDADDENTROPY needs CAP_SYS_ADMIN")
		}
		t.Fatalf("addEntropy: %v", err)
	}
	if n != defaultEntropyBytes {
		t.Errorf("credited %d bytes, want the %d-byte default", n, defaultEntropyBytes)
	}
}
