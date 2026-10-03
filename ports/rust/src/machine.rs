//! The CPUs this process may use (affinity and cgroup quota), the threads to run on them, and what they keep busy.

pub const PAGES_IN_FLIGHT_PER_THREAD: usize = 24;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Machine {
    pub cpus: usize,
    pub threads: usize,
    pub max_concurrency: usize,
}

impl Machine {
    pub fn detect(override_cpus: usize) -> Self {
        let cpus = if override_cpus > 0 {
            override_cpus
        } else {
            std::thread::available_parallelism().map_or(1, |p| p.get())
        };
        let threads = if cpus <= 2 { cpus } else { cpus - 1 };
        Self {
            cpus,
            threads,
            max_concurrency: (PAGES_IN_FLIGHT_PER_THREAD * threads)
                .clamp(1, crate::options::MAX_CONCURRENCY),
        }
    }
}

#[cfg(test)]
#[path = "machine_test.rs"]
mod tests;
