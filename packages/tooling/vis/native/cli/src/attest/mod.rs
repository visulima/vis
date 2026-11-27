//! `vis attest <subject>` (the offline run of `src/commands/attest/`), natively.
//!
//! [`emit`] answers the run that has no ambient OIDC token: Node hashes the artifact and skips signing, with a JSON
//! document or a warning. A run that signs (`CI` equal to `true`, a GitHub Actions token, a Sigstore token),
//! `--require-signing` and every failure (they are thrown, with a stack) are Node's, and a hand-off names its reason on
//! stderr when `VIS_DEBUG_DECLINE` is set.
//!
//! `vis attest verify` is not answered here: attestation verification has one implementation, the Node one, so the
//! binary hands every shape of it over before any output.

pub(crate) mod emit;

/// What the flags of a leaf were: the values and switches it takes and the words that are neither.
#[derive(Debug, Default, PartialEq, Eq)]
struct Parsed {
    values: Vec<(&'static str, String)>,
    switches: Vec<&'static str>,
    words: Vec<String>,
}

impl Parsed {
    fn value(&self, name: &str) -> Option<&str> {
        self.values.iter().find(|(key, _)| *key == name).map(|(_, value)| value.as_str())
    }

    fn switch(&self, name: &str) -> bool {
        self.switches.contains(&name)
    }
}

/// The arguments after the command words: `--name value` or `--name=value` for each of `values`, `--name` for each of
/// `switches`, every one at most once, and plain words. A value that is empty or starts with a dash, any other flag, a
/// switch with a value and `--` are `None`: cerebro reads them in ways this does not.
fn parse(rest: &[String], values: &[&'static str], switches: &[&'static str]) -> Option<Parsed> {
    let mut parsed = Parsed::default();
    let mut tokens = rest.iter();

    while let Some(token) = tokens.next() {
        let Some(flag) = token.strip_prefix("--") else {
            if token.starts_with('-') {
                return None;
            }

            parsed.words.push(token.clone());

            continue;
        };
        let (name, inline) = match flag.split_once('=') {
            Some((name, value)) => (name, Some(value)),
            None => (flag, None),
        };

        if let Some(known) = switches.iter().find(|known| **known == name) {
            if inline.is_some() || parsed.switches.contains(known) {
                return None;
            }

            parsed.switches.push(known);

            continue;
        }

        let known = values.iter().find(|known| **known == name)?;
        let value = inline.or_else(|| tokens.next().map(String::as_str))?;

        if value.is_empty() || value.starts_with('-') || parsed.value(known).is_some() {
            return None;
        }

        parsed.values.push((known, value.to_owned()));
    }

    Some(parsed)
}

/// The `--format` values the command reads: `json` and `ndjson` are machine formats, `table` is the default, and
/// Node reads any other text as `table`, which this does not rely on.
fn format_of(parsed: &Parsed) -> Option<&str> {
    match parsed.value("format") {
        None => Some("table"),
        Some(format @ ("json" | "ndjson" | "table")) => Some(format),
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn values_switches_and_words_parse_and_everything_else_does_not() {
        let parsed = parse(
            &tokens(&["dist/app.tgz", "--format", "json", "--require-signing", "--output=out.sigstore"]),
            &["format", "output"],
            &["require-signing"],
        )
        .unwrap();

        assert_eq!(parsed.words, ["dist/app.tgz"]);
        assert_eq!(parsed.value("format"), Some("json"));
        assert_eq!(parsed.value("output"), Some("out.sigstore"));
        assert!(parsed.switch("require-signing") && !parsed.switch("other"));

        for odd in [
            &["--format"][..],
            &["--format", "--json"],
            &["--format="],
            &["--format", "a", "--format", "b"],
            &["--format=a", "--format=b"],
            &["--require-signing", "--require-signing"],
            &["--require-signing=true"],
            &["--unknown", "x"],
            &["-f", "json"],
            &["--"],
            &["--no-format"],
        ] {
            assert!(parse(&tokens(odd), &["format"], &["require-signing"]).is_none(), "{odd:?}");
        }
    }

    #[test]
    fn the_format_is_one_of_three() {
        let format = |list: &[&str]| {
            let parsed = parse(&tokens(list), &["format"], &[]).unwrap();

            format_of(&parsed).map(str::to_owned)
        };

        assert_eq!(format(&[]).as_deref(), Some("table"));
        assert_eq!(format(&["--format", "json"]).as_deref(), Some("json"));
        assert_eq!(format(&["--format=ndjson"]).as_deref(), Some("ndjson"));
        assert_eq!(format(&["--format", "xml"]), None);
    }
}
