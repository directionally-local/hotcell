//go:build linux

package server

import (
	"crypto/rand"
	"fmt"
	"unsafe"

	"golang.org/x/sys/unix"
)

// defaultEntropyBytes is how much fresh host entropy a fork mixes into the
// guest CRNG when the caller doesn't ask for a specific amount.
const defaultEntropyBytes = 256

// randPoolInfo mirrors Linux's `struct rand_pool_info` (include/uapi/linux/random.h):
// an entropy credit followed by the bytes to mix in.
type randPoolInfo struct {
	EntropyCount int32
	BufSize      int32
	Buf          [defaultEntropyBytes]byte
}

// reseedGuest applies a clone's fresh identity inside the guest.
//
// Order matters: the CRNG is reseeded first so that even if a later step fails,
// the clone is not left sharing the template's random state.
func reseedGuest(hostname, machineID string, unixTime int64, entropyBytes int) (ReseedResult, error) {
	res := ReseedResult{}

	n, err := addEntropy(entropyBytes)
	if err != nil {
		return res, err
	}
	res.EntropyBytes = n

	if hostname != "" {
		if err := unix.Sethostname([]byte(hostname)); err != nil {
			return res, fmt.Errorf("sethostname: %w", err)
		}
		res.Hostname = hostname
	}
	if machineID != "" {
		res.MachineID = machineID
	}
	if unixTime > 0 {
		ts := unix.NsecToTimespec(unixTime * 1_000_000_000)
		if err := unix.ClockSettime(unix.CLOCK_REALTIME, &ts); err != nil {
			return res, fmt.Errorf("clock_settime: %w", err)
		}
		res.ClockSet = true
	}
	// Best-effort: the syscall-level identity above is what isolation depends on.
	_ = writeIdentityFiles("/", hostname, machineID)
	return res, nil
}

// addEntropy mixes `n` bytes of host randomness into the guest kernel CRNG via
// RNDADDENTROPY. Returns the number of bytes actually credited.
func addEntropy(n int) (int, error) {
	if n <= 0 {
		n = defaultEntropyBytes
	}
	if n > defaultEntropyBytes {
		n = defaultEntropyBytes
	}
	info := randPoolInfo{EntropyCount: int32(n * 8), BufSize: int32(n)}
	if _, err := rand.Read(info.Buf[:n]); err != nil {
		return 0, fmt.Errorf("read host entropy: %w", err)
	}
	fd, err := unix.Open("/dev/urandom", unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return 0, fmt.Errorf("open /dev/urandom: %w", err)
	}
	defer unix.Close(fd)
	_, _, errno := unix.Syscall(
		unix.SYS_IOCTL,
		uintptr(fd),
		uintptr(unix.RNDADDENTROPY),
		uintptr(unsafe.Pointer(&info)),
	)
	if errno != 0 {
		return 0, fmt.Errorf("RNDADDENTROPY: %w", errno)
	}
	return n, nil
}
