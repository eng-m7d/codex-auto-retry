package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const usageSnapshotCacheDuration = 30 * time.Second

type UsageWindowSnapshot struct {
	UsedPercent      int     `json:"used_percent"`
	RemainingPercent int     `json:"remaining_percent"`
	WindowMinutes    *int64  `json:"window_minutes,omitempty"`
	ResetsAt         string  `json:"resets_at,omitempty"`
}

type CodexUsageSnapshot struct {
	Available bool                 `json:"available"`
	Source    string               `json:"source,omitempty"`
	FetchedAt string               `json:"fetched_at,omitempty"`
	Error     string               `json:"error,omitempty"`
	FiveHour  *UsageWindowSnapshot `json:"five_hour,omitempty"`
	Weekly    *UsageWindowSnapshot `json:"weekly,omitempty"`
}

type appRateLimitWindow struct {
	UsedPercent        int    `json:"usedPercent"`
	WindowDurationMins *int64 `json:"windowDurationMins"`
	ResetsAt           *int64 `json:"resetsAt"`
}

type appRateLimitSnapshot struct {
	LimitID   string              `json:"limitId"`
	Primary   *appRateLimitWindow `json:"primary"`
	Secondary *appRateLimitWindow `json:"secondary"`
}

type appRateLimitsReadResult struct {
	OrdinaryUsageAllowed *bool                           `json:"ordinaryUsageAllowed"`
	RateLimits           appRateLimitSnapshot            `json:"rateLimits"`
	RateLimitsByLimitID  map[string]appRateLimitSnapshot `json:"rateLimitsByLimitId"`
}

type stdioRPCMessage struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

func (m *managementService) usageSnapshotLocked(config Config, now time.Time) CodexUsageSnapshot {
	if !m.usageCacheAt.IsZero() && now.Sub(m.usageCacheAt) < usageSnapshotCacheDuration {
		return m.usageCache
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	home := preferredUsageCodexHome(config)
	snapshot, err := readCodexUsageSnapshot(ctx, home, now)
	if err != nil {
		if m.usageCache.Available {
			stale := m.usageCache
			stale.Error = "refresh_failed"
			m.usageCache = stale
			m.usageCacheAt = now
			return stale
		}
		snapshot = CodexUsageSnapshot{
			Available: false,
			Source:    "account/rateLimits/read",
			FetchedAt: now.Format(time.RFC3339Nano),
			Error:     "usage_unavailable",
		}
	}
	m.usageCache = snapshot
	m.usageCacheAt = now
	return snapshot
}

func preferredUsageCodexHome(config Config) string {
	if explicit := strings.TrimSpace(os.Getenv("CODEX_HOME")); explicit != "" {
		return expandPath(explicit)
	}
	roots := discoverSessionRoots(config)
	for _, root := range roots {
		if _, err := os.Stat(filepath.Join(root.CodexHome, "auth.json")); err == nil {
			return root.CodexHome
		}
	}
	if len(roots) > 0 {
		return roots[0].CodexHome
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".codex")
	}
	return ""
}

func readCodexUsageSnapshot(ctx context.Context, codexHome string, now time.Time) (CodexUsageSnapshot, error) {
	executable, err := findUsageCodexExecutable()
	if err != nil {
		return CodexUsageSnapshot{}, err
	}
	command := exec.CommandContext(ctx, executable, "app-server")\n\tprepareUsageCommand(command)
	if strings.TrimSpace(codexHome) != "" {
		command.Env = replaceEnvironmentValue(os.Environ(), "CODEX_HOME", codexHome)
	}
	stdin, err := command.StdinPipe()
	if err != nil {
		return CodexUsageSnapshot{}, err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return CodexUsageSnapshot{}, err
	}
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return CodexUsageSnapshot{}, err
	}
	defer func() {
		_ = stdin.Close()
		if command.Process != nil {
			_ = command.Process.Kill()
		}
		_ = command.Wait()
	}()

	reader := bufio.NewReader(stdout)
	if err := writeRPCLine(stdin, map[string]any{
		"id": 1,
		"method": "initialize",
		"params": map[string]any{
			"clientInfo": map[string]any{
				"name": "codex_auto_retry_usage",
				"title": "Codex Auto Retry Usage",
				"version": appVersion,
			},
			"capabilities": map[string]any{"experimentalApi": true},
		},
	}); err != nil {
		return CodexUsageSnapshot{}, err
	}
	if _, err := readRPCResult(ctx, reader, 1); err != nil {
		return CodexUsageSnapshot{}, err
	}
	if err := writeRPCLine(stdin, map[string]any{"method": "initialized"}); err != nil {
		return CodexUsageSnapshot{}, err
	}
	if err := writeRPCLine(stdin, map[string]any{
		"id": 2,
		"method": "account/rateLimits/read",
		"params": map[string]any{"excludeResetCreditDetails": true},
	}); err != nil {
		return CodexUsageSnapshot{}, err
	}
	raw, err := readRPCResult(ctx, reader, 2)
	if err != nil {
		return CodexUsageSnapshot{}, err
	}
	var response appRateLimitsReadResult
	if err := json.Unmarshal(raw, &response); err != nil {
		return CodexUsageSnapshot{}, fmt.Errorf("decode rate limits: %w", err)
	}

	rateLimits := response.RateLimits
	if codex, ok := response.RateLimitsByLimitID["codex"]; ok {
		rateLimits = codex
	}
	five, weekly := classifyUsageWindows(rateLimits.Primary, rateLimits.Secondary)
	if five == nil && weekly == nil {
		return CodexUsageSnapshot{}, errors.New("rate limit windows are unavailable")
	}
	return CodexUsageSnapshot{
		Available: true,
		Source:    "account/rateLimits/read",
		FetchedAt: now.Format(time.RFC3339Nano),
		FiveHour:  usageWindowSnapshot(five),
		Weekly:    usageWindowSnapshot(weekly),
	}, nil
}

func writeRPCLine(writer io.Writer, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	_, err = writer.Write(data)
	return err
}

func readRPCResult(ctx context.Context, reader *bufio.Reader, wantedID int64) (json.RawMessage, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		line, err := reader.ReadBytes('\n')
		if err != nil {
			return nil, err
		}
		var message stdioRPCMessage
		if json.Unmarshal(line, &message) != nil {
			continue
		}
		if len(message.ID) == 0 {
			continue
		}
		var id int64
		if json.Unmarshal(message.ID, &id) != nil || id != wantedID {
			continue
		}
		if message.Error != nil {
			return nil, fmt.Errorf("app-server request failed: %d", message.Error.Code)
		}
		return message.Result, nil
	}
}

func classifyUsageWindows(primary, secondary *appRateLimitWindow) (*appRateLimitWindow, *appRateLimitWindow) {
	windows := []*appRateLimitWindow{primary, secondary}
	var five, weekly *appRateLimitWindow
	for _, window := range windows {
		if window == nil || window.WindowDurationMins == nil {
			continue
		}
		minutes := *window.WindowDurationMins
		switch {
		case minutes >= 240 && minutes <= 360:
			five = window
		case minutes >= 6*24*60:
			weekly = window
		}
	}
	if five == nil {
		five = primary
	}
	if weekly == nil && secondary != five {
		weekly = secondary
	}
	return five, weekly
}

func usageWindowSnapshot(window *appRateLimitWindow) *UsageWindowSnapshot {
	if window == nil {
		return nil
	}
	used := window.UsedPercent
	if used < 0 {
		used = 0
	}
	if used > 100 {
		used = 100
	}
	result := &UsageWindowSnapshot{
		UsedPercent:      used,
		RemainingPercent: 100 - used,
		WindowMinutes:    window.WindowDurationMins,
	}
	if window.ResetsAt != nil && *window.ResetsAt > 0 {
		result.ResetsAt = time.Unix(*window.ResetsAt, 0).UTC().Format(time.RFC3339Nano)
	}
	return result
}

func findUsageCodexExecutable() (string, error) {
	if executable, err := exec.LookPath("codex"); err == nil {
		return executable, nil
	}
	if localAppData := os.Getenv("LOCALAPPDATA"); localAppData != "" {
		root := filepath.Join(localAppData, "OpenAI", "Codex", "bin")
		var candidates []string
		_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
			if err == nil && !entry.IsDir() && strings.EqualFold(entry.Name(), "codex.exe") {
				candidates = append(candidates, path)
			}
			return nil
		})
		if len(candidates) > 0 {
			sort.Slice(candidates, func(i, j int) bool {
				left, _ := os.Stat(candidates[i])
				right, _ := os.Stat(candidates[j])
				if left == nil || right == nil {
					return candidates[i] > candidates[j]
				}
				return left.ModTime().After(right.ModTime())
			})
			return candidates[0], nil
		}
	}
	if appData := os.Getenv("APPDATA"); appData != "" {
		root := filepath.Join(appData, "npm", "node_modules", "@openai", "codex")
		var candidate string
		_ = filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
			if candidate == "" && err == nil && !entry.IsDir() && strings.EqualFold(entry.Name(), "codex.exe") {
				candidate = path
			}
			return nil
		})
		if candidate != "" {
			return candidate, nil
		}
	}
	return "", errors.New("Codex executable was not found")
}
