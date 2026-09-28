package main

import (
	"errors"
	"testing"
	"time"
)

func TestStartRuntimeRestoreThenRegisterDoesNotWaitForPanel(t *testing.T) {
	restored := make(chan struct{})
	registerStarted := make(chan struct{})
	releaseRegister := make(chan struct{})
	defer close(releaseRegister)
	registerDone := make(chan error, 1)
	go func() {
		registerDone <- startRuntimeRestoreThenRegister(Config{PanelURL: "https://panel.invalid"}, func(Config) {
			close(restored)
		}, func(Config) error {
			close(registerStarted)
			// 模拟面板被黑洞：register 一直挂到测试结束。
			<-releaseRegister
			return errors.New("panel unreachable")
		})
	}()
	select {
	case <-restored:
	case <-time.After(2 * time.Second):
		t.Fatal("persisted runtimes were not restored while register was blocked on the panel")
	}
	select {
	case <-registerStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("register was not attempted")
	}
	select {
	case err := <-registerDone:
		t.Fatalf("register returned early: %v", err)
	default:
	}
}

func TestStartRuntimeRestoreThenRegisterReturnsRegisterError(t *testing.T) {
	want := errors.New("register failed")
	restored := make(chan struct{})
	got := startRuntimeRestoreThenRegister(Config{}, func(Config) { close(restored) }, func(Config) error { return want })
	if !errors.Is(got, want) {
		t.Fatalf("register error = %v, want %v", got, want)
	}
	select {
	case <-restored:
	case <-time.After(2 * time.Second):
		t.Fatal("restore did not run when register failed")
	}
}
