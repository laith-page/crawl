package main

import (
	_ "embed"
	"fmt"

	"go.l3.ai/cli"
)

// What -V prints (DESIGN §1): tools writes it before every build (version.txt, git-ignored).
//
//go:embed version.txt
var version string

const defaultUserAgent = "crawler/1.0"

var command = cli.Command{
	Program: "crawl", Positional: "url", Invalid: "not an http or https URL",
	VersionHelp: "version and libraries", See: "see DESIGN §1",
	VersionText: func() (string, error) { return version, nil },
	Switches: []cli.Switch{
		{Name: "-f", Env: "CRAWL_FAST", Help: "fast: as many requests as this machine takes, no delay"},
		{Name: "-v", Env: "CRAWL_VERBOSE", Help: "verbose: the settings this crawl runs with, on stderr"},
	},
	Flags: []cli.Flag{
		{Name: "-c", Value: "N", Help: "requests in flight at most", Default: 1, Min: 1, Max: maxConcurrency, Env: "CRAWL_MAX_CONCURRENCY"},
		{Name: "-n", Value: "N", Help: "pages to crawl at most", Default: 1000, Min: 1, Env: "CRAWL_MAX_PAGES"},
		{Name: "-t", Value: "SECONDS", Help: "seconds per request timeout", Default: 10, Min: 1, Max: 120, Env: "CRAWL_TIMEOUT"},
		// -d is given in seconds with up to 3 decimals, stored as integer milliseconds.
		{Name: "-d", Value: "SECONDS", Help: "seconds between request starts", Default: 1000, Min: 0, Max: 60000, Env: "CRAWL_DELAY", Decimals: 3},
	},
	Settings: []cli.Setting{{Env: "CRAWL_CPUS", Default: 0, Min: 1, Max: 1024}},
	Texts:    []cli.Text{{Env: "CRAWL_USER_AGENT", Default: defaultUserAgent}},
}

type Options struct {
	fast, verbose               bool
	concurrency, maxPages       int
	timeoutSeconds, delayMillis int
	userAgent, url              string
}

func of(parsed cli.Parsed, machine Machine) Options {
	fast := parsed.On("-f")
	concurrency := 1
	if parsed.Given("-c") {
		concurrency = parsed.Get("-c")
	} else if fast {
		concurrency = machine.maxConcurrency
	}
	delayMillis := 1000
	if parsed.Given("-d") {
		delayMillis = parsed.Get("-d")
	} else if fast {
		delayMillis = 0
	}
	return Options{
		fast: fast, verbose: parsed.On("-v"), concurrency: concurrency,
		maxPages: parsed.Get("-n"), timeoutSeconds: parsed.Get("-t"), delayMillis: delayMillis,
		userAgent: parsed.Text("CRAWL_USER_AGENT"),
		url:       parsed.Positional(),
	}
}

func (options Options) settings(machine Machine) string {
	mode := "polite"
	if options.fast {
		mode = "fast"
	}
	return fmt.Sprintf("settings: %s, cpus %d, threads %d, concurrency %d (max %d), delay %ss, timeout %ds, pages %d", mode, machine.cpus, machine.threads, options.concurrency, machine.maxConcurrency, cli.Decimal(options.delayMillis, 3), options.timeoutSeconds, options.maxPages)
}
