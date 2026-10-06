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

	"github.com/KimMachineGun/automemlimit/memlimit"
	"go.l3.ai/certs"
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
	parsed, code, ok := command.Prepare(args, os.Getenv, stdout, stderr, startURL)
	if !ok {
		return code
	}
	machine := detect(parsed.Get("CRAWL_CPUS"))
	runtime.GOMAXPROCS(machine.threads)
	return crawl(of(parsed, machine), machine, stdout, stderr)
}

func crawl(options Options, machine Machine, stdout, stderr io.Writer) int {
	trust := certs.FromEnv(os.Getenv)
	if trust.Warning != "" {
		fmt.Fprintln(stderr, trust.Warning)
	}
	if options.verbose {
		fmt.Fprintln(stderr, options.settings(machine))
	}
	fetcher := newFetcher(options, trust.CertFile)
	sig := signals.Trap()
	defer sig.Close()
	return newCrawler(options.url, options.concurrency, options.maxPages).crawl(fetcher.fetch, stdout, stderr, sig)
}
