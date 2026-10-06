package crawler;

/** Sizing for this machine: CPUs, runtime threads and the max concurrency they can keep in flight. */
record Machine(int cpus, int threads, int maxConcurrency) {

    static final int MAX_CONCURRENCY = 256;
    static final int PAGES_IN_FLIGHT_PER_THREAD = 24;

    static Machine detect(int overrideCpus) {
        int cpus = overrideCpus > 0 ? overrideCpus : Runtime.getRuntime().availableProcessors();
        int threads = cpus <= 2 ? cpus : cpus - 1;
        return new Machine(cpus, threads, Math.min(MAX_CONCURRENCY, PAGES_IN_FLIGHT_PER_THREAD * threads));
    }

    // Configures Loom virtual thread carrier pool.
    void apply() {
        System.setProperty("jdk.virtualThreadScheduler.parallelism", Integer.toString(threads));
        System.setProperty("jdk.virtualThreadScheduler.maxPoolSize", Integer.toString(threads + 1));
    }
}
