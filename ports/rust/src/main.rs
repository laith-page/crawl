//! The web crawler CLI entry point: parses options, runs the crawl and maps its end to an exit code.

mod crawler;
mod failure;
mod fetcher;
mod frontier;
mod links;
mod machine;
mod options;
mod page;
mod retries;
mod tracker;
mod urls;

use crawler::Crawler;
use fetcher::Fetcher;
use machine::Machine;
use options::Options;
use std::{io::Write, process::ExitCode, sync::Arc, time::Duration};

/// Give each runtime thread one glibc arena and return large freed blocks through mmap.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn tune_malloc(threads: usize) {
    #[allow(unsafe_code)]
    unsafe {
        libc::mallopt(libc::M_ARENA_MAX, threads as libc::c_int);
        libc::mallopt(libc::M_MMAP_THRESHOLD, 131_072);
    }
}

fn run(args: &[String], mut stdout: impl Write, mut stderr: impl Write) -> ExitCode {
    let version = || Ok(include_str!(concat!(env!("OUT_DIR"), "/version.txt")).to_string());
    let values = match options::COMMAND.prepare(
        args,
        |key| std::env::var(key).ok(),
        &mut stdout,
        &mut stderr,
        version,
        urls::start_url,
    ) {
        cli::Prepared::Run(values) => values,
        cli::Prepared::Exit(code) => return code,
    };
    let machine = Machine::detect(values.get("CRAWL_CPUS"));
    let options = Options::of(values, &machine);
    crawl(options, machine, stdout, stderr)
}

fn crawl(
    options: Options,
    machine: Machine,
    stdout: impl Write,
    mut stderr: impl Write,
) -> ExitCode {
    let trust = certs::from_env();
    if let Some(warning) = trust.warning {
        writeln!(stderr, "{warning}").ok();
    }
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    tune_malloc(machine.threads);
    if options.verbose {
        writeln!(stderr, "{}", options.settings(&machine)).ok();
    }
    let pacer = Arc::new(pacing::Pacer::new(Duration::from_millis(
        options.delay_millis as u64,
    )));

    let fetcher = Fetcher::new(&options, trust.cert_file, pacer)
        .unwrap_or_else(|e| fatal(1, &format!("error: {e}")));
    let signals = signals::Signals::trap();
    let crawler = Crawler::new(options.url, options.concurrency, options.max_pages, signals);

    let code = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(machine.threads.min(options.concurrency))
        .enable_all()
        .build()
        .unwrap()
        .block_on(async move {
            let f = fetcher.clone();
            let code = crawler
                .crawl(move |url| f.clone().fetch(url), stdout, stderr)
                .await;
            fetcher.settle().await;
            code
        });
    ExitCode::from(code as u8)
}

fn main() -> ExitCode {
    std::panic::set_hook(Box::new(|info| {
        let why = info.payload_as_str().unwrap_or("bug");
        fatal(1, &format!("error: internal error: {why}"))
    }));
    let args: Vec<_> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    run(&args, std::io::stdout(), std::io::stderr())
}

fn fatal(code: i32, message: &str) -> ! {
    let _ = writeln!(std::io::stderr(), "{message}");
    std::process::exit(code)
}
