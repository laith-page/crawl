//! The URL form over e2e/urls.json, the corpus every engine resolves.

use super::{resolve, start_url};

const CORPUS_FILE: &str = include_str!("../../../e2e/urls.json");

/// A row of the corpus: the page (None for the command line), the href, the URL wanted (None for no link).
struct Row {
    base: Option<String>,
    href: String,
    want: Option<String>,
}

#[test]
fn resolves_every_row_of_the_corpus_as_the_form_says() {
    let rows = corpus();
    assert!(rows.len() > 100, "the corpus has rows");
    let mut wrong = Vec::new();
    for row in &rows {
        let got = match &row.base {
            Some(base) => resolve(base, &row.href),
            None => start_url(&row.href),
        };
        if got != row.want {
            wrong.push(format!(
                "{:?} + {:?}: want {:?}, got {:?}",
                row.base, row.href, row.want, got
            ));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} rows differ:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}

fn corpus() -> Vec<Row> {
    let bytes: Vec<char> = CORPUS_FILE.chars().collect();
    let mut at = 0;
    let mut rows = Vec::new();
    skip_space(&bytes, &mut at);
    expect(&bytes, &mut at, '[');
    loop {
        skip_space(&bytes, &mut at);
        if bytes[at] == ']' {
            break;
        }
        expect(&bytes, &mut at, '{');
        let (mut base, mut href, mut want) = (None, String::new(), None);
        loop {
            skip_space(&bytes, &mut at);
            let key = string(&bytes, &mut at);
            skip_space(&bytes, &mut at);
            expect(&bytes, &mut at, ':');
            skip_space(&bytes, &mut at);
            let value = if bytes[at..].starts_with(&['n', 'u', 'l', 'l']) {
                at += 4;
                None
            } else {
                Some(string(&bytes, &mut at))
            };
            match key.as_str() {
                "base" => base = value,
                "href" => href = value.unwrap_or_default(),
                "want" => want = value,
                _ => {}
            }
            skip_space(&bytes, &mut at);
            if bytes[at] == '}' {
                at += 1;
                break;
            }
            expect(&bytes, &mut at, ',');
        }
        rows.push(Row { base, href, want });
        skip_space(&bytes, &mut at);
        if bytes[at] == ',' {
            at += 1;
        }
    }
    rows
}

fn skip_space(bytes: &[char], at: &mut usize) {
    while bytes[*at].is_whitespace() {
        *at += 1;
    }
}

fn expect(bytes: &[char], at: &mut usize, expected: char) {
    assert_eq!(bytes[*at], expected, "at {}", *at);
    *at += 1;
}

fn string(bytes: &[char], at: &mut usize) -> String {
    expect(bytes, at, '"');
    let mut out = String::new();
    while bytes[*at] != '"' {
        let character = bytes[*at];
        *at += 1;
        if character != '\\' {
            out.push(character);
            continue;
        }
        let escape = bytes[*at];
        *at += 1;
        match escape {
            'n' => out.push('\n'),
            't' => out.push('\t'),
            'r' => out.push('\r'),
            'b' => out.push('\u{8}'),
            'f' => out.push('\u{c}'),
            'u' => {
                let hex: String = bytes[*at..*at + 4].iter().collect();
                *at += 4;
                let mut code = u32::from_str_radix(&hex, 16).unwrap();
                // a surrogate pair is two \u escapes
                if (0xD800..0xDC00).contains(&code) && bytes[*at] == '\\' && bytes[*at + 1] == 'u' {
                    let low: String = bytes[*at + 2..*at + 6].iter().collect();
                    let low = u32::from_str_radix(&low, 16).unwrap();
                    code = 0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
                    *at += 6;
                }
                out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
            }
            other => out.push(other),
        }
    }
    *at += 1;
    out
}
