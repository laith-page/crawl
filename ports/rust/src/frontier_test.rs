use super::Frontier;
use collections::{CHUNK_BYTES, Hashes};
use url::Url;

const HOME: &str = "http://example.com/";
/// A queue cap no test reaches.
const ROOMY: usize = 1 << 30;

#[test]
fn push_drops_a_link_the_full_seen_set_refuses() {
    let mut frontier = Frontier::with_seen(HOME, 1_000_000, ROOMY, Hashes::sized_for(0)); // 1,024 slots, full at 768
    (0..1000).for_each(|index| frontier.push(&Url::parse(&format!("{HOME}{index}")).unwrap()));
    // the start URL and 767 links: the rest are neither remembered nor queued
    assert_eq!((frontier.seen.size(), frontier.queued()), (768, 768));
}

#[test]
fn push_remembers_no_link_the_queue_turns_away() {
    let mut frontier = Frontier::with_seen(
        HOME,
        1_000_000,
        2 * CHUNK_BYTES,
        Hashes::sized_for(1_000_000),
    );
    let link = |index: usize| Url::parse(&format!("{HOME}{index}-{}", "x".repeat(2000))).unwrap();
    (0..200).for_each(|index| frontier.push(&link(index)));
    let held = frontier.queued();
    assert!(
        (60..=70).contains(&held),
        "held {held} of 200 links; want about 64"
    );
    (0..10).for_each(|_| {
        frontier.pop();
    });
    frontier.push(&link(199)); // turned away before, so not remembered
    assert_eq!(frontier.seen.size(), frontier.queued() + 10);
}

#[test]
fn push_keeps_only_links_on_the_start_host() {
    let mut frontier = Frontier::new(HOME, 100);
    // the start origin as a prefix, another host
    for other in [
        "http://example.com.evil.test/",
        "http://example.com@evil.test/",
        "http://other.test/",
    ] {
        frontier.push(&Url::parse(other).unwrap());
    }
    assert_eq!(frontier.queued(), 1);
    for same in [
        "http://example.com:8080/",
        "https://example.com/a",
        "http://example.com/b",
    ] {
        frontier.push(&Url::parse(same).unwrap());
    }
    assert_eq!(frontier.queued(), 4);
}
