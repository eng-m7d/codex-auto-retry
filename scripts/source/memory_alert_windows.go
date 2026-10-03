//go:build windows

package main

import (
	"fmt"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const memoryAlertTimeout = 15 * time.Second

func showMemoryLimitAlert(sample memorySample, limitMB int) {
	title, titleErr := windows.UTF16PtrFromString("تم إيقاف Codex Auto Retry تلقائياً")
	message, messageErr := windows.UTF16PtrFromString(fmt.Sprintf(
		"بلغت ذاكرة عملية الخلفية %d MB وتجاوزت الحد المحدد %d MB.\n\nتم إيقاف خدمة الاستئناف التلقائي تلقائياً من دون حذف Codex أو بيانات المهام. بعد إغلاق العمليات غير الطبيعية، أعد تشغيل الخدمة من مدير بدء التشغيل.",
		memoryBytesToMB(sample.PrivateBytes), limitMB,
	))
	if titleErr != nil || messageErr != nil {
		return
	}
	user32 := windows.NewLazySystemDLL("user32.dll")
	// MessageBoxTimeoutW is available on supported Windows versions and keeps a
	// safety alert from holding the worker alive forever when unattended.
	timeoutProc := user32.NewProc("MessageBoxTimeoutW")
	result, _, _ := timeoutProc.Call(
		0,
		uintptr(unsafe.Pointer(message)),
		uintptr(unsafe.Pointer(title)),
		0x30|0x10000,
		0,
		uintptr(memoryAlertTimeout.Milliseconds()),
	)
	if result != 0 {
		return
	}
	// Older or restricted hosts may not export MessageBoxTimeoutW. Fall back to
	// a normal box in a bounded goroutine; process shutdown still wins.
	done := make(chan struct{})
	go func() {
		box := user32.NewProc("MessageBoxW")
		box.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x30|0x10000)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(memoryAlertTimeout):
	}
}
