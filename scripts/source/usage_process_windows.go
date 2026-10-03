//go:build windows

package main

import "os/exec"

func prepareUsageCommand(command *exec.Cmd) {
	command.SysProcAttr = hiddenInheritedConsoleAttributes()
}
