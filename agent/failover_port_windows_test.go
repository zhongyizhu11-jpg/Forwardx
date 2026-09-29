//go:build windows

package main

import "testing"

func reserveRefusingPort(t *testing.T) (int, bool) { return 0, false }

func refusingTestPort(t *testing.T) int { return failoverTestPort(t) }
