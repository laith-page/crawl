use super::*;

fn of(args: &[&str], machine: &Machine) -> Options {
    let cli::Parsed::Run(values) = COMMAND.parse(args, |_| None, crate::urls::start_url) else {
        panic!("valid command line")
    };
    Options::of(values, machine)
}

#[test]
fn concurrency() {
    let machine = Machine {
        cpus: 2,
        threads: 2,
        max_concurrency: 48,
    };
    assert_eq!(of(&["http://example.com"], &machine).concurrency, 1);
    assert_eq!(of(&["-f", "http://example.com"], &machine).concurrency, 48);
    assert_eq!(
        of(&["-f", "-c", "4", "http://example.com"], &machine).concurrency,
        4
    );
}

#[test]
fn settings() {
    let machine = Machine {
        cpus: 2,
        threads: 2,
        max_concurrency: 48,
    };
    let polite = of(&["-d", "0.25", "http://example.com"], &machine);
    assert_eq!(
        polite.settings(&machine),
        "settings: polite, cpus 2, threads 2, concurrency 1 (max 48), delay 0.25s, timeout 10s, pages 1000"
    );
    let fast = of(&["-f", "http://example.com"], &machine);
    assert_eq!(
        fast.settings(&machine),
        "settings: fast, cpus 2, threads 2, concurrency 48 (max 48), delay 0s, timeout 10s, pages 1000"
    );
}
