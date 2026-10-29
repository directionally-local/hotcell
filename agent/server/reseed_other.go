//go:build !linux

package server

import "errors"

// reseedGuest is a stub for non-Linux builds. The agent only ever runs as a
// Linux guest; this exists so the server package compiles (and its protocol and
// handlers stay testable) on the developer's macOS box.
func reseedGuest(hostname, machineID string, unixTime int64, entropyBytes int) (ReseedResult, error) {
	return ReseedResult{}, errors.New("reseed is only supported in a Linux guest")
}
