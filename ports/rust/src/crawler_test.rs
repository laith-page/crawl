use super::Crawler;
use crate::page::Page;
use collections::CHUNK_BYTES;
use std::future::{Ready, ready};
use std::io::{ErrorKind, Write};
use url::Url;

const HOME: &str = "http://example.com/";
/// A queue cap no test reaches.
const ROOMY: usize = 1 << 30;
const BREADTH_FIRST: &str = "\
http://example.com/ 200
http://example.com/a 200
http://example.com/b 200
http://example.com/c 200
http://example.com/d 200
http://example.com/gone 404
";

/// / links to /a, /b and off the host; /a and /b to /c, which links to /; /d to a 404.
fn site(url: String) -> Ready<Page> {
    let links: &[&str] = match &url[HOME.len() - 1..] {
        "/" => &["a", "b", "http://other.example/"],
        "/a" => &["c", "b"],
        "/b" => &["c", "d"],
        "/c" => &[""],
        "/d" => &["gone"],
        _ => return ready(Page::response(url, 404, Vec::new())),
    };
    let links = links
        .iter()
        .map(|link| Url::parse(HOME).unwrap().join(link).unwrap())
        .collect();
    ready(Page::response(url, 200, links))
}

/// Home links to 3,000 pages of 100-byte names, which no single chunk holds; every other page is a leaf.
fn wide(url: String) -> Ready<Page> {
    if url != HOME {
        return ready(Page::response(url, 200, Vec::new()));
    }
    let links = (0..3000)
        .map(|i| Url::parse(&format!("{HOME}{i}/{}", "x".repeat(100))).unwrap())
        .collect();
    ready(Page::response(url, 200, links))
}

struct Crawled {
    stdout: String,
    stderr: String,
    code: i32,
}

async fn crawl_home(
    fetch: fn(String) -> Ready<Page>,
    concurrency: usize,
    max_pages: usize,
    max_queue_bytes: usize,
) -> Crawled {
    let (mut stdout, mut stderr) = (Vec::new(), Vec::new());
    let mut crawler = Crawler::new(HOME.to_string(), concurrency, max_pages, signals::Signals);
    if max_queue_bytes != crate::frontier::MAX_QUEUE_BYTES {
        crawler.frontier = crate::frontier::Frontier::with_seen(
            HOME,
            max_pages,
            max_queue_bytes,
            collections::Hashes::sized_for(max_pages),
        );
    }
    let code = crawler.crawl(fetch, &mut stdout, &mut stderr).await;
    let text = |bytes| String::from_utf8(bytes).unwrap();
    Crawled {
        stdout: text(stdout),
        stderr: text(stderr),
        code,
    }
}

fn sorted_lines(out: &str) -> Vec<&str> {
    let mut lines: Vec<_> = out.lines().collect();
    lines.sort_unstable();
    lines
}

fn pages(out: &str) -> usize {
    out.lines().count()
}

#[tokio::test]
async fn crawl_is_breadth_first_in_document_order() {
    let one = crawl_home(site, 1, 100, ROOMY).await;
    assert_eq!((one.stdout.as_str(), one.code), (BREADTH_FIRST, 0));
    assert!(
        one.stderr.starts_with("crawled 6 pages in "),
        "{}",
        one.stderr
    );
    assert!(one.stderr.ends_with("s, 0 errors\n"), "{}", one.stderr); // a 404 is a page, not an error
    let eight = crawl_home(site, 8, 100, ROOMY).await;
    assert_eq!(sorted_lines(&eight.stdout), sorted_lines(&one.stdout));
}

#[tokio::test]
async fn crawl_queues_no_link_past_the_queue_bytes() {
    let run = crawl_home(wide, 1, 10_000, CHUNK_BYTES).await;
    let pages = pages(&run.stdout); // one 64 KiB chunk holds about 600 of them
    assert!((500..700).contains(&pages), "pages: {pages}");
}

struct FailingWriter(ErrorKind);

impl Write for FailingWriter {
    fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
        Err(self.0.into())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn crawl_stops_when_stdout_fails() {
    let cases = [
        (ErrorKind::StorageFull, 1, "error: cannot write output\n"),
        (ErrorKind::BrokenPipe, 0, ""),
        (ErrorKind::ConnectionReset, 0, ""),
    ];
    for (kind, code, want) in cases {
        let mut stderr = Vec::new();
        let got = Crawler::new(HOME.to_string(), 1, 9, signals::Signals)
            .crawl(site, FailingWriter(kind), &mut stderr)
            .await;
        assert_eq!(got, code);
        // an error after the summary (DESIGN §2); a pipe closed by its reader, a clean end
        assert!(String::from_utf8(stderr).unwrap().ends_with(want));
    }
}

#[tokio::test]
async fn crawl_reports_a_failed_last_flush() {
    struct FailsAfterFirstWrite {
        wrote: bool,
    }

    impl Write for FailsAfterFirstWrite {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.wrote {
                return Err(std::io::Error::other("No space left on device"));
            }
            self.wrote = true;
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let mut stderr = Vec::new();
    let code = Crawler::new(HOME.to_string(), 1, 100, signals::Signals)
        .crawl(site, FailsAfterFirstWrite { wrote: false }, &mut stderr)
        .await;
    assert_eq!(code, 1);
    assert!(
        String::from_utf8(stderr)
            .unwrap()
            .ends_with("error: cannot write output\n")
    );
}
