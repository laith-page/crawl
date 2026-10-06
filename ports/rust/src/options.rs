//! The crawler's command line and environment, declared for the cli library (DESIGN §1).
use crate::machine::{MAX_CONCURRENCY, Machine};
use cli::{Command, Flag, Setting, Switch, Text, Values};

const SWITCHES: &[Switch<'static>] = &[
    Switch::new(
        "-f",
        "CRAWL_FAST",
        "fast: as many requests as this machine takes, no delay",
    ),
    Switch::new(
        "-v",
        "CRAWL_VERBOSE",
        "verbose: the settings this crawl runs with, on stderr",
    ),
];
const FLAGS: &[Flag<'static>] = &[
    Flag::new(
        "-c",
        "N",
        "requests in flight at most",
        1,
        1,
        Some(MAX_CONCURRENCY),
    )
    .env("CRAWL_MAX_CONCURRENCY"),
    Flag::new("-n", "N", "pages to crawl at most", 1000, 1, None).env("CRAWL_MAX_PAGES"),
    Flag::new(
        "-t",
        "SECONDS",
        "seconds per request timeout",
        10,
        1,
        Some(120),
    )
    .env("CRAWL_TIMEOUT"),
    // delay in milliseconds: the CLI takes whole or fractional seconds with 3 decimals (DESIGN §1)
    Flag::new(
        "-d",
        "SECONDS",
        "seconds between request starts",
        1000,
        0,
        Some(60000),
    )
    .env("CRAWL_DELAY")
    .decimals(3),
];
const DEFAULT_USER_AGENT: &str = "crawler/1.0";
const SETTINGS: &[Setting<'static>] = &[Setting {
    env: "CRAWL_CPUS",
    default: 0,
    min: 1,
    max: Some(1024),
}];
const TEXTS: &[Text<'static>] = &[Text {
    env: "CRAWL_USER_AGENT",
    default: DEFAULT_USER_AGENT,
}];

pub const COMMAND: Command<'static> = Command {
    program: "crawl",
    positional: "url",
    invalid: "not an http or https URL",
    flags: FLAGS,
    switches: SWITCHES,
    settings: SETTINGS,
    texts: TEXTS,
    version_help: Some("version and libraries"),
    see: Some("see DESIGN §1"),
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Options {
    pub fast: bool,
    pub verbose: bool,
    pub concurrency: usize,
    pub max_pages: usize,
    pub timeout_seconds: u64,
    pub delay_millis: u32,
    pub user_agent: String,
    pub url: String,
}

impl Options {
    pub fn of(values: Values<'_>, machine: &Machine) -> Self {
        let fast = values.on("-f");
        let concurrency = if values.given("-c") {
            values.get("-c")
        } else if fast {
            machine.max_concurrency
        } else {
            1
        };
        let delay_millis = if values.given("-d") {
            values.get("-d") as u32
        } else if fast {
            0
        } else {
            1000
        };
        Self {
            fast,
            verbose: values.on("-v"),
            concurrency,
            max_pages: values.get("-n"),
            timeout_seconds: values.get("-t") as u64,
            delay_millis,
            user_agent: values.text("CRAWL_USER_AGENT").to_string(),
            url: values.positional().to_string(),
        }
    }

    pub fn settings(&self, machine: &Machine) -> String {
        format!(
            "settings: {}, cpus {}, threads {}, concurrency {} (max {}), delay {}s, timeout {}s, pages {}",
            if self.fast { "fast" } else { "polite" },
            machine.cpus,
            machine.threads,
            self.concurrency,
            machine.max_concurrency,
            cli::decimal(self.delay_millis as usize, 3),
            self.timeout_seconds,
            self.max_pages
        )
    }
}

#[cfg(test)]
#[path = "options_test.rs"]
mod tests;
