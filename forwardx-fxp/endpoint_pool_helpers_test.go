package main

import "time"

func setEndpointRetryAfter(selector *exitEndpointSelector, index int, at time.Time) {
	state := selector.states[index]
	state.mu.Lock()
	state.retryAfter = at
	state.mu.Unlock()
}
