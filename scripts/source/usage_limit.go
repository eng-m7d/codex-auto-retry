package main

import (
	"regexp"
	"strings"
	"time"
)

const usageLimitResumeGrace = time.Minute

var (
	usageLimitRetryAtPattern = regexp.MustCompile(`(?i)(?:or\s+)?try again at\s+([^\r\n.]+)`)
	ordinalDayPattern        = regexp.MustCompile(`(?i)(\d{1,2})(st|nd|rd|th)`)
)

func usageLimitRetryAt(errorText string, now time.Time) (time.Time, bool) {
	normalized := strings.ToLower(strings.ReplaceAll(errorText, "’", "'"))
	if !strings.Contains(normalized, "usage limit") {
		return time.Time{}, false
	}

	match := usageLimitRetryAtPattern.FindStringSubmatch(errorText)
	if len(match) != 2 {
		return time.Time{}, false
	}

	value := strings.TrimSpace(match[1])
	value = strings.TrimRight(value, " ,;")
	value = ordinalDayPattern.ReplaceAllString(value, "$1")
	location := now.Location()

	for _, layout := range []string{"Jan 2, 2006 3:04 PM", "January 2, 2006 3:04 PM"} {
		if parsed, err := time.ParseInLocation(layout, value, location); err == nil {
			return parsed, true
		}
	}

	parsedTime, err := time.ParseInLocation("3:04 PM", value, location)
	if err != nil {
		return time.Time{}, false
	}
	return time.Date(now.Year(), now.Month(), now.Day(), parsedTime.Hour(), parsedTime.Minute(), 0, 0, location), true
}

func usageLimitDueAt(errorText string, now time.Time) (time.Time, bool) {
	resetAt, ok := usageLimitRetryAt(errorText, now)
	if !ok {
		return time.Time{}, false
	}

	if !resetAt.After(now) {
		return now.Add(usageLimitResumeGrace), true
	}
	return resetAt.Add(usageLimitResumeGrace), true
}
