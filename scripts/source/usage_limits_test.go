package main

import (
	"testing"
	"time"
)

func int64Pointer(value int64) *int64 { return &value }

func TestClassifyUsageWindowsFindsFiveHourAndWeeklyBuckets(t *testing.T) {
	five := &appRateLimitWindow{
		UsedPercent: 41,
		WindowDurationMins: int64Pointer(300),
	}
	weekly := &appRateLimitWindow{
		UsedPercent: 73,
		WindowDurationMins: int64Pointer(10080),
	}
	gotFive, gotWeekly := classifyUsageWindows(five, weekly)
	if gotFive != five {
		t.Fatalf("five-hour window was not selected: %#v", gotFive)
	}
	if gotWeekly != weekly {
		t.Fatalf("weekly window was not selected: %#v", gotWeekly)
	}
}

func TestUsageWindowSnapshotClampsPercentAndFormatsReset(t *testing.T) {
	reset := time.Date(2026, 10, 4, 12, 30, 0, 0, time.UTC).Unix()
	minutes := int64(300)
	got := usageWindowSnapshot(&appRateLimitWindow{
		UsedPercent: 108,
		WindowDurationMins: &minutes,
		ResetsAt: &reset,
	})
	if got == nil {
		t.Fatal("snapshot is nil")
	}
	if got.UsedPercent != 100 || got.RemainingPercent != 0 {
		t.Fatalf("unexpected percentages: %+v", got)
	}
	if got.ResetsAt != "2026-10-04T12:30:00Z" {
		t.Fatalf("unexpected reset timestamp: %q", got.ResetsAt)
	}
}

func TestClassifyUsageWindowsFallsBackToPrimaryAndSecondary(t *testing.T) {
	primary := &appRateLimitWindow{UsedPercent: 20}
	secondary := &appRateLimitWindow{UsedPercent: 40}
	gotFive, gotWeekly := classifyUsageWindows(primary, secondary)
	if gotFive != primary || gotWeekly != secondary {
		t.Fatalf("fallback classification failed: five=%p weekly=%p", gotFive, gotWeekly)
	}
}
