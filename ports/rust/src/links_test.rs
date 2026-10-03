use super::MAX_LINKS;
use crate::urls::{MAX_BYTES, resolve};
use url::Url;

/// The links of `html` on `page`, printed.
fn extract(html: &[u8], page: &str) -> Vec<String> {
    let mut links = super::Links::new(Url::parse(page).unwrap());
    links.feed(html);
    links.end().into_iter().map(String::from).collect()
}

#[test]
fn a_byte_at_a_time_finds_the_same_links() {
    let page = Url::parse("http://example.com/").unwrap();
    let document = b"<!-- <a href=/no> --><a href=/one><script><a href=/no></script><a href=/two>";
    let mut links = super::Links::new(page.clone());
    for byte in document {
        links.feed(std::slice::from_ref(byte));
    }
    let streamed = links.end();
    let mut whole = super::Links::new(page);
    whole.feed(document);
    assert_eq!(streamed, whole.end());
}

/// The set finds a repeat as a scan does: first seen first kept, up to MAX_LINKS distinct.
#[test]
fn extract_keeps_each_link_once_in_document_order() {
    let page = "http://example.com/d/";
    let mut html = String::new();
    for i in 0..1500 {
        html.push_str(&format!(
            "<a href=\"/{}\"><a href=\"x{i}\"><a href=\"/{}\">",
            i % 7,
            i / 2
        ));
    }
    let mut want: Vec<String> = Vec::new();
    for href in html::Hrefs::of(html.as_bytes()) {
        let url = resolve(page, &href).unwrap();
        if want.len() < MAX_LINKS && !want.contains(&url) {
            want.push(url);
        }
    }
    assert_eq!(extract(html.as_bytes(), page), want);
    assert_eq!(want.len(), MAX_LINKS);
}

/// A simple path, which the url crate joins without its parser, is held to the length too: past 8,000 bytes it is no
/// link.
#[test]
fn a_joined_link_past_the_byte_limit_is_no_link() {
    let page = "http://example.com/d/";
    let rooted = format!("/{}", "r".repeat(MAX_BYTES - "http://example.com/".len()));
    let relative = "l".repeat(MAX_BYTES - page.len());
    let html =
        format!("<a href={rooted}><a href={rooted}r><a href={relative}><a href={relative}l>");
    assert_eq!(
        extract(html.as_bytes(), page),
        [
            format!("http://example.com{rooted}"),
            format!("{page}{relative}")
        ]
    );
}

/// Every prefix of a document of every construct, and 20,000 of random pieces: links in the form, printable.
#[test]
fn extract_returns_only_printable_links() {
    let page = "http://example.com/dir/page";
    let doc = concat!(
        "<html><head><base href=\"/b/\"><title><a href=\"/t\"></title><style>a{}</style></head><body>\n",
        "<!-- <a href=\"/c\"> --><script>'<a href=\"/s\">'</script><a title='x>y' href=\"q?a=1&amp;b=&#x32;\">\n",
        "<a HREF=/u>u</a><textarea><a href=/ta></textarea><a href=\"https://other.example#f\">o</a>",
    );
    for end in 0..=doc.len() {
        expect_printable(&doc.as_bytes()[..end], page);
    }
    let pieces: [&[u8]; 38] = [
        b"<a href=",
        b"<A HREF='",
        b"<base href=\"",
        b"\"",
        b"'",
        b">",
        b"<",
        b"/",
        b" ",
        b"\n",
        b"\0",
        b"&amp;",
        b"&#x",
        b"&#",
        b";",
        b"<!--",
        b"-->",
        b"<script>",
        b"</script",
        b"<title",
        b"</textarea>",
        b"http://",
        b"https://h/",
        b"//",
        b"?",
        b"#",
        b"..",
        b"%",
        b"[",
        b"]",
        b":",
        b"@",
        b"=",
        b"\\",
        b"\xe9",
        b"\xc3\xa9",
        b"^",
        b"{",
    ];
    let mut random = fastrand::Rng::with_seed(0x5eed);
    for _ in 0..20_000 {
        let mut html = Vec::new();
        while html.len() < 496 {
            if random.bool() {
                html.extend_from_slice(pieces[random.usize(..pieces.len())]);
            } else {
                html.push(random.u8(..));
            }
            if random.u8(..64) == 0 {
                break;
            }
        }
        expect_printable(&html, page);
    }
}

fn expect_printable(html: &[u8], page: &str) {
    let found = extract(html, page);
    assert!(found.len() <= MAX_LINKS);
    for url in found {
        assert!(
            url.starts_with("http://") || url.starts_with("https://"),
            "{url}"
        );
        assert!(url.len() <= MAX_BYTES, "{url}");
        assert!(url.bytes().all(|byte| byte > b' ' && byte < 0x7f), "{url}");
    }
}
