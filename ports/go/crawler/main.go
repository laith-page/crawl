package main

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"runtime"
	"runtime/pprof"
	"syscall"
	"time"

	"github.com/KimMachineGun/automemlimit/memlimit"
	"go.l3.ai/cli"
	"go.l3.ai/signals"
)

func main() {
	defer fatal()
	memlimit.Set(memlimit.WithLogger(slog.New(slog.DiscardHandler)))
	signal.Ignore(syscall.SIGPIPE)
	stop := profileCPU()
	code := run(os.Args[1:], os.Stdout, os.Stderr)
	stop()
	os.Exit(code)
}

func profileCPU() func() {
	if path := os.Getenv("TOOLS_CPUPROFILE"); path != "" {
		if file, err := os.Create(path); err == nil {
			runtime.SetCPUProfileRate(1000)
			if pprof.StartCPUProfile(file) == nil {
				return func() { pprof.StopCPUProfile(); file.Close() }
			}
			file.Close()
		}
	}
	return func() {}
}

func fatal() {
	if recovered := recover(); recovered != nil {
		fmt.Fprintf(os.Stderr, "error: internal error: %v\n", recovered)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) int {
	return cli.Run(&command, args, os.Getenv, stdout, stderr, startURL, func(parsed cli.Parsed) (int, error) {
		machine := detect(parsed.Get("CRAWL_CPUS"))
		runtime.GOMAXPROCS(machine.threads)
		options := of(parsed, machine)
		certFile := os.Getenv("SSL_CERT_FILE")
		if certFile != "" {
			file, err := os.Open(certFile)
			unreadable := err != nil
			if !unreadable {
				info, statErr := file.Stat()
				unreadable = statErr != nil || !info.Mode().IsRegular()
				file.Close()
			}
			if unreadable {
				fmt.Fprintln(stderr, "warning: SSL_CERT_FILE is unreadable; trusting no certificates")
			}
		}
		if options.verbose {
			fmt.Fprintln(stderr, options.settings(machine))
		}
		throttle := newThrottle(options.delayMillis, !options.fast)
		fetcher := newFetcher(newTls(certFile), options.concurrency, time.Duration(options.timeoutSeconds)*time.Second, throttle, options.userAgent)
		signals := signals.Trap()
		defer signals.Close()
		return newCrawler(options.url, options.concurrency, options.maxPages).crawl(fetcher.fetch, stdout, stderr, signals), nil
	})
}
