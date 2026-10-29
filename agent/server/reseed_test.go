package server

import (
	"os"
	"path/filepath"
	"testing"
)

// A fork must not leave two clones sharing a machine-id, so the identity files
// are rewritten in place. This exercises the platform-independent half of
// reseed (the syscalls live in reseed_linux.go).
func TestWriteIdentityFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "etc"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeIdentityFiles(root, "cell-1", "11111111-2222-3333-4444-555555555555"); err != nil {
		t.Fatalf("writeIdentityFiles: %v", err)
	}
	for _, tc := range []struct{ path, want string }{
		{"etc/hostname", "cell-1\n"},
		{"etc/machine-id", "11111111-2222-3333-4444-555555555555\n"},
	} {
		got, err := os.ReadFile(filepath.Join(root, tc.path))
		if err != nil {
			t.Fatalf("read %s: %v", tc.path, err)
		}
		if string(got) != tc.want {
			t.Errorf("%s = %q, want %q", tc.path, got, tc.want)
		}
	}
	// dbus's copy is only written when its directory already exists.
	if _, err := os.Stat(filepath.Join(root, "var", "lib", "dbus")); !os.IsNotExist(err) {
		t.Errorf("writeIdentityFiles invented a dbus directory")
	}
}

// A guest without /etc must be left alone rather than having directories
// invented for it.
func TestWriteIdentityFilesSkipsMissingDirs(t *testing.T) {
	root := t.TempDir()
	if err := writeIdentityFiles(root, "cell-2", "abc"); err != nil {
		t.Fatalf("writeIdentityFiles: %v", err)
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("expected no files created, got %d entries", len(entries))
	}
}

// An empty request is still valid: it means "reseed entropy only".
func TestWriteIdentityFilesEmpty(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "etc"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeIdentityFiles(root, "", ""); err != nil {
		t.Fatalf("writeIdentityFiles: %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(root, "etc"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("expected no identity files, got %d", len(entries))
	}
}
