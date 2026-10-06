package main

import (
	"testing"
)

func TestConcurrency(t *testing.T) {
	machine := Machine{cpus: 2, threads: 2, maxConcurrency: 48}
	for _, test := range []struct {
		args []string
		want int
	}{
		{[]string{"http://example.com/"}, 1},
		{[]string{"-f", "http://example.com/"}, 48},
		{[]string{"-f", "-c", "4", "http://example.com/"}, 4},
	} {
		parsed, err := command.Parse(test.args, func(string) string { return "" }, startURL)
		if err != nil {
			t.Fatal(err)
		}
		options := of(parsed, machine)
		if got := options.concurrency; got != test.want {
			t.Errorf("%v: concurrency %d, want %d", test.args, got, test.want)
		}
	}
}

func TestSettings(t *testing.T) {
	machine := Machine{cpus: 2, threads: 2, maxConcurrency: 48}
	parsed, err := command.Parse([]string{"-d", "0.25", "http://example.com/"}, func(string) string { return "" }, startURL)
	if err != nil {
		t.Fatal(err)
	}
	options := of(parsed, machine)
	want := "settings: polite, cpus 2, threads 2, concurrency 1 (max 48), delay 0.25s, timeout 10s, pages 1000"
	if got := options.settings(machine); got != want {
		t.Errorf("settings = %q, want %q", got, want)
	}
}
