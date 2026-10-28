package main

import (
	"bufio"
	"net"
	"testing"
)

func TestAuthenticateAcceptsMatchingToken(t *testing.T) {
	serverConn, clientConn := net.Pipe()
	defer serverConn.Close()
	defer clientConn.Close()

	done := make(chan error, 1)
	go func() { done <- authenticate(serverConn, "secret") }()
	if _, err := clientConn.Write([]byte("HOTCELL/1 secret\n")); err != nil {
		t.Fatal(err)
	}
	response, err := bufio.NewReader(clientConn).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if response != agentAuthAccepted {
		t.Fatalf("response = %q, want %q", response, agentAuthAccepted)
	}
	if err := <-done; err != nil {
		t.Fatalf("authenticate: %v", err)
	}
}

func TestAuthenticateRejectsWrongToken(t *testing.T) {
	serverConn, clientConn := net.Pipe()
	defer serverConn.Close()
	defer clientConn.Close()

	done := make(chan error, 1)
	go func() { done <- authenticate(serverConn, "secret") }()
	if _, err := clientConn.Write([]byte("HOTCELL/1 wrong\n")); err != nil {
		t.Fatal(err)
	}
	response, err := bufio.NewReader(clientConn).ReadString('\n')
	if err != nil {
		t.Fatal(err)
	}
	if response != agentAuthRejected {
		t.Fatalf("response = %q, want %q", response, agentAuthRejected)
	}
	if err := <-done; err == nil {
		t.Fatal("authenticate accepted the wrong token")
	}
}
