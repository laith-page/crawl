package crawler;

/** Sizing for this machine: CPUs, runtime threads and the max concurrency they can keep in flight. */
record Machine(int cpus, int threads, int maxConcurrency) {

    static final int PAGES_IN_FLIGHT_PER_THREAD = 24;

    static Machine detect(int overrideCpus) {
        int cpus = overrideCpus > 0 ? overrideCpus : Runtime.getRuntime().availableProcessors();
        int threads = cpus <= 2 ? cpus : cpus - 1;
        return new Machine(cpus, threads, Math.min(Options.MAX_CONCURRENCY, PAGES_IN_FLIGHT_PER_THREAD * threads));
    }

    // Configures Loom virtual thread carrier pool; http.maxConnections sizes ai.l3:http's pool only while it wraps
    // HttpURLConnection.
    void apply(int concurrency) {
        System.setProperty("jdk.virtualThreadScheduler.parallelism", Integer.toString(threads));
        System.setProperty("jdk.virtualThreadScheduler.maxPoolSize", Integer.toString(threads + 1));
        System.setProperty("http.maxConnections", Integer.toString(concurrency));
    }
}
