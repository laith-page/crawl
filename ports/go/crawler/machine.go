// Sizing for this machine: CPUs, runtime threads and the max concurrency they can keep in flight.
package main

import (
	"runtime"
)

const pagesInFlightPerThread = 24

type Machine struct {
	cpus, threads, maxConcurrency int
}

func detect(cpus int) Machine {
	if cpus <= 0 {
		cpus = runtime.GOMAXPROCS(0)
	}
	threads := cpus - 1
	if cpus <= 2 {
		threads = cpus
	}
	return Machine{cpus: cpus, threads: threads, maxConcurrency: min(maxConcurrency, pagesInFlightPerThread*threads)}
}
