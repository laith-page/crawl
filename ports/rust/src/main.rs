//! The web crawler CLI entry point: parses options, runs the crawl and maps its end to an exit code.

mod crawler;
mod failure;
mod fetcher;
mod frontier;
mod http;
mod links;
mod machine;
mod options;
mod output;
mod page;
mod retries;
mod throttle;
mod tls;
mod tracker;
mod urls;

use crawler::Crawler;
use fetcher::Fetcher;
use http::Http;
use machine::Machine;
use options::Options;
use std::{convert::Infallible, io::Write, process::ExitCode, sync::Arc, time::Duration};
use throttle::Throttle;
use tls::Tls;

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
    let mut parsed = None;
    let code = options::COMMAND.run(
        args,
        |key| std::env::var(key).ok(),
        &mut stdout,
        &mut stderr,
        || {
            Ok(include_str!(concat!(env!("OUT_DIR"), "/version.txt"))
                .trim_end_matches(['\r', '\n'])
                .to_string())
        },
        urls::start_url,
        |values| {
            let machine = Machine::detect(values.get("CRAWL_CPUS"));
            parsed = Some((Options::of(values, &machine), machine));
            Ok::<_, Infallible>(ExitCode::SUCCESS)
        },
    );
    let Some((options, machine)) = parsed else {
        return code;
    };
    let cert_file = std::env::var_os("SSL_CERT_FILE");
    if let Some(path) = &cert_file {
        let readable = std::fs::File::open(path)
            .and_then(|file| file.metadata())
            .is_ok_and(|metadata| metadata.is_file());
        if !readable {
            writeln!(
                stderr,
                "warning: SSL_CERT_FILE is unreadable; trusting no certificates"
            )
            .ok();
        }
    }
    #[cfg(all(target_os = "linux", target_env = "gnu"))]
    tune_malloc(machine.threads);
    if options.verbose {
        writeln!(stderr, "{}", options.settings(&machine)).ok();
    }
    let throttle = Arc::new(Throttle::new(options.delay_millis, !options.fast));

    let tls = Tls::new(cert_file);
    let timeout = Duration::from_secs(options.timeout_seconds);
    let http = Http::new(&tls, options.concurrency, &options.user_agent)
        .unwrap_or_else(|error| fatal(1, &format!("error: {error}")));
    let fetcher = Fetcher {
        http: http.clone(),
        timeout,
        throttle: throttle.clone(),
    };

    let signals = signals::Signals::trap();
    let crawler = Crawler::new(options.url, options.concurrency, options.max_pages, signals);

    let code = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(machine.threads.min(options.concurrency))
        .enable_all()
        .build()
        .unwrap()
        .block_on(async move {
            let code = crawler
                .crawl(move |url| fetcher.clone().fetch(url), stdout, stderr)
                .await;
            // A handshake hyper left running in the background ends before the process does (Http::settled);
            // the deadline only bounds one a server stalls.
            let _ = tokio::time::timeout(timeout, http.settled()).await;
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
