package main

import (
	"errors"
	"reflect"
	"testing"
)

func TestIsManagedFXPCmdline(t *testing.T) {
	cases := []struct {
		args []string
		want bool
	}{
		{[]string{"/usr/local/bin/forwardx-fxp", "-config", "/run/forwardx-agent/fxp-exit-1-2-3.json"}, true},
		{[]string{"forwardx-fxp", "-config", "/run/forwardx-agent/fxp-entry-group-v2-9.json"}, true},
		{[]string{"/usr/lib/systemd/systemd-resolved"}, false},
		{[]string{"/usr/sbin/dnsmasq", "-config", "/run/forwardx-agent/fxp-exit-1-2-3.json"}, false},
		{[]string{"/usr/local/bin/forwardx-fxp", "-config", "/etc/other.json"}, false},
		{[]string{"/usr/local/bin/forwardx-fxp", "-config", "/run/forwardx-agent/../../etc/fxp-x.json"}, false},
		{[]string{"/usr/local/bin/forwardx-fxp"}, false},
	}
	for _, tc := range cases {
		if got := isManagedFXPCmdline(tc.args); got != tc.want {
			t.Fatalf("isManagedFXPCmdline(%v) = %v, want %v", tc.args, got, tc.want)
		}
	}
}

func TestKillManagedFXPOnUDPPortLeavesForeignProcesses(t *testing.T) {
	oldList, oldRead, oldKill := listUDPListenPortPIDs, readProcessCmdline, killProcessByPID
	defer func() { listUDPListenPortPIDs, readProcessCmdline, killProcessByPID = oldList, oldRead, oldKill }()

	listUDPListenPortPIDs = func(port int) []int {
		if port != 53 {
			t.Fatalf("unexpected port %d", port)
		}
		return []int{101, 202, 303}
	}
	cmdlines := map[int][]string{
		101: {"/usr/lib/systemd/systemd-resolved"},
		202: {"/usr/local/bin/forwardx-fxp", "-config", "/run/forwardx-agent/fxp-exit-7-8-9.json"},
	}
	readProcessCmdline = func(pid int) ([]string, error) {
		if args, ok := cmdlines[pid]; ok {
			return args, nil
		}
		return nil, errors.New("gone")
	}
	var killed []int
	killProcessByPID = func(pid int) { killed = append(killed, pid) }

	killManagedFXPOnUDPPort(53)
	if !reflect.DeepEqual(killed, []int{202}) {
		t.Fatalf("killed = %v, want only the Agent-managed FXP pid", killed)
	}
}
