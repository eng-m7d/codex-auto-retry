//go:build !windows

package main

import "os/exec"

func prepareUsageCommand(_ *exec.Cmd) {}
