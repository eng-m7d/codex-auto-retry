package main

import (
	"testing"
	"time"
)

func TestOfficialUsageLimitIsClassifiedSeparately(t *testing.T) {
	decision := classifyFailure("You’ve hit your usage limit. Try again at 11:45 PM.", defaultConfig())
	if !decision.Retry || decision.Class != classUsageLimit {
		t.Fatalf("official usage limit was not classified correctly: %+v", decision)
	}
}

func TestUsageLimitRetryAtParsesOfficialSameDayFormat(t *testing.T) {
	location := time.FixedZone("UTC+3", 3*60*60)
	now := time.Date(2026, 10, 3, 19, 30, 0, 0, location)
	got, ok := usageLimitRetryAt("You’ve hit your usage limit. Try again at 11:45 PM.", now)
	want := time.Date(2026, 10, 3, 23, 45, 0, 0, location)
	if !ok || !got.Equal(want) {
		t.Fatalf("same-day reset parse = %v, %v; want %v, true", got, ok, want)
	}
}

func TestUsageLimitRetryAtParsesOfficialDatedFormat(t *testing.T) {
	location := time.FixedZone("UTC+3", 3*60*60)
	now := time.Date(2026, 10, 3, 23, 30, 0, 0, location)
	got, ok := usageLimitRetryAt("You’ve hit your usage limit. Try again at Oct 4th, 2026 3:45 PM.", now)
	want := time.Date(2026, 10, 4, 15, 45, 0, 0, location)
	if !ok || !got.Equal(want) {
		t.Fatalf("dated reset parse = %v, %v; want %v, true", got, ok, want)
	}
}

func TestUsageLimitSchedulingWaitsForResetAndBypassesTimeGuard(t *testing.T) {
	config := isolatedConfig(t.TempDir())
	config.MaxRecoveryAttempts = maxRecoveryAttemptsLimit
	config.MaxConsecutiveRetries = maxConsecutiveRetriesLimit
	d := newTestDaemon(t, config, successfulRunner())
	threadID := "019fa94e-0103-7183-b405-36bd307b6dc1"
	location := time.FixedZone("UTC+3", 3*60*60)
	now := time.Date(2026, 10, 3, 19, 30, 0, 0, location)
	thread := ThreadState{
		RecoveryAttempts:   10,
		ConsecutiveRetries: 10,
		RecoveryStartedAt:  now.Add(-2 * time.Hour),
	}
	event := failureScannedEvent(threadID, "retry", now)
	event.Event.ErrorText = "You’ve hit your usage limit. Try again at 11:45 PM."

	d.scheduleFailureLocked(event, "usage-limit-event", now, thread, 11, 11, time.Time{}, false)
	state := d.state.Threads[threadID]
	wantDueAt := time.Date(2026, 10, 3, 23, 46, 0, 0, location)
	if state.Stopped != nil || state.Pending == nil {
		t.Fatalf("usage limit was stopped instead of scheduled: %+v", state)
	}
	if state.Pending.Class != classUsageLimit || !state.Pending.DueAt.Equal(wantDueAt) {
		t.Fatalf("usage-limit schedule = %+v; want due_at %v", state.Pending, wantDueAt)
	}
}

func TestDueUsageLimitRetryBypassesThirtyMinuteDispatchGuard(t *testing.T) {
	config := isolatedConfig(t.TempDir())
	d := newTestDaemon(t, config, successfulRunner())
	threadID := "019fa94e-0103-7183-b405-36bd307b6dc2"
	now := time.Date(2026, 10, 4, 1, 0, 0, 0, time.UTC)
	d.state.Threads[threadID] = ThreadState{
		RecoveryStartedAt: now.Add(-4 * time.Hour),
		Pending: &PendingRetry{
			EventKey: "usage-limit-event", FailedTurnID: "failed", Class: classUsageLimit,
			DueAt: now, Attempt: 1, MaxAttempts: 15, ConsecutiveRetry: 1, MaxConsecutive: 5,
		},
	}

	jobs := d.dispatchDueLocked(now)
	state := d.state.Threads[threadID]
	if len(jobs) != 1 || state.Stopped != nil || state.Awaiting == nil {
		t.Fatalf("due usage-limit retry was blocked by elapsed-time guard: jobs=%d state=%+v", len(jobs), state)
	}
}
