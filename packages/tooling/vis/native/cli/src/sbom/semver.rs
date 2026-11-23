//! The part of node-semver's `maxSatisfying(versions, range, { includePrerelease: true })` that
//! `vis sbom` needs, ported from semver 7.8.5 (`classes/range.js`).
//!
//! Only the range grammar below is evaluated: comparators (`>=`, `>`, `<=`, `<`, `=` or none), caret,
//! tilde and x-ranges over `major[.minor[.patch[-pre]]]`, joined by spaces and `||`, and hyphen ranges between
//! two of those. A range written any other way (a `v` prefix, build metadata, `~>`, an operator with no version, a
//! number that does not fit a double) is [`Unsupported`], and the caller hands the whole run to Node.
//! A range node-semver rejects (a dist-tag, a URL, a `workspace:` protocol) is not an error: node-semver
//! returns `null` for it, and so does [`max_satisfying`].

use std::cmp::Ordering;

/// The input is outside the grammar this module reproduces.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Unsupported;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Ident {
    Num(u64),
    Str(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Version {
    main: [u64; 3],
    pre: Vec<Ident>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Op {
    Eq,
    Ge,
    Gt,
    Le,
    Lt,
}

/// One comparator; `None` is the any-version comparator (`*`, or an empty range).
type Comparator = Option<(Op, Version)>;

/// Digits of a number kept exactly: node-semver rejects past `Number.MAX_SAFE_INTEGER`, which this
/// module leaves to Node rather than reproducing.
const MAX_DIGITS: usize = 15;

fn compare_identifiers(a: &Ident, b: &Ident) -> Ordering {
    match (a, b) {
        (Ident::Num(a), Ident::Num(b)) => a.cmp(b),
        (Ident::Num(_), Ident::Str(_)) => Ordering::Less,
        (Ident::Str(_), Ident::Num(_)) => Ordering::Greater,
        (Ident::Str(a), Ident::Str(b)) => a.cmp(b),
    }
}

/// `SemVer.compare`: the three numbers, then the pre-release (a version without one is greater). Build
/// metadata does not take part.
fn compare(a: &Version, b: &Version) -> Ordering {
    a.main.cmp(&b.main).then_with(|| match (a.pre.is_empty(), b.pre.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            for index in 0.. {
                match (a.pre.get(index), b.pre.get(index)) {
                    (None, None) => return Ordering::Equal,
                    (Some(_), None) => return Ordering::Greater,
                    (None, Some(_)) => return Ordering::Less,
                    (Some(x), Some(y)) if x == y => {}
                    (Some(x), Some(y)) => return compare_identifiers(x, y),
                }
            }

            Ordering::Equal
        }
    })
}

fn is_numeric_identifier(text: &str) -> bool {
    text == "0"
        || (text.starts_with(|c: char| c.is_ascii_digit() && c != '0') && text.bytes().all(|b| b.is_ascii_digit()))
}

enum Parsed<T> {
    Valid(T),
    /// node-semver throws (a range) or skips the entry (a version).
    Invalid,
    Unsupported,
}

/// A numeric identifier of the main version or a pre-release: `0` or digits without a leading zero.
fn number(text: &str) -> Parsed<u64> {
    if !is_numeric_identifier(text) {
        return Parsed::Invalid;
    }

    if text.len() > MAX_DIGITS {
        return Parsed::Unsupported;
    }

    text.parse().map_or(Parsed::Unsupported, Parsed::Valid)
}

/// The identifiers of a pre-release, `a.b.1`.
fn pre_release(text: &str) -> Parsed<Vec<Ident>> {
    let mut idents = Vec::new();

    for part in text.split('.') {
        if part.bytes().all(|b| b.is_ascii_digit()) && !part.is_empty() {
            match number(part) {
                Parsed::Valid(value) => idents.push(Ident::Num(value)),
                Parsed::Invalid => return Parsed::Invalid,
                Parsed::Unsupported => return Parsed::Unsupported,
            }
        } else if !part.is_empty()
            && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && part.bytes().any(|b| b.is_ascii_alphabetic() || b == b'-')
        {
            idents.push(Ident::Str(part.to_owned()));
        } else {
            return Parsed::Invalid;
        }
    }

    Parsed::Valid(idents)
}

/// `new SemVer(text)` for the plain `major.minor.patch[-pre][+build]` form.
fn parse_version(text: &str) -> Parsed<Version> {
    if text.len() > 256 {
        return Parsed::Invalid;
    }

    // A `v` prefix and surrounding spaces are accepted by node-semver; they are left to Node.
    if text.starts_with('v') || text != text.trim() {
        return Parsed::Unsupported;
    }

    let (rest, build) = match text.split_once('+') {
        Some((rest, build)) => (rest, Some(build)),
        None => (text, None),
    };

    if let Some(build) = build {
        let valid = build
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'));

        if !valid {
            return Parsed::Invalid;
        }
    }

    let (core, pre) = match rest.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (rest, None),
    };

    let parts: Vec<&str> = core.split('.').collect();

    if parts.len() != 3 {
        return Parsed::Invalid;
    }

    let mut main = [0; 3];

    for (slot, part) in main.iter_mut().zip(parts) {
        match number(part) {
            Parsed::Valid(value) => *slot = value,
            Parsed::Invalid => return Parsed::Invalid,
            Parsed::Unsupported => return Parsed::Unsupported,
        }
    }

    match pre.map(pre_release) {
        None => Parsed::Valid(Version { main, pre: Vec::new() }),
        Some(Parsed::Valid(pre)) => Parsed::Valid(Version { main, pre }),
        Some(Parsed::Invalid) => Parsed::Invalid,
        Some(Parsed::Unsupported) => Parsed::Unsupported,
    }
}

/// An x-range part: a number, or `x`, `X`, `*`, or missing.
#[derive(Clone, Copy)]
enum Part {
    Number(u64),
    Wild,
}

impl Part {
    fn number(self) -> Option<u64> {
        match self {
            Self::Number(value) => Some(value),
            Self::Wild => None,
        }
    }
}

/// `major[.minor[.patch[-pre]]]` with wildcards, the `XRANGEPLAIN` of node-semver.
struct Partial {
    major: Part,
    minor: Part,
    patch: Part,
    pre: Vec<Ident>,
    /// `isX(M) && !isX(m)` or `isX(m) && p && !isX(p)`: `replaceXRange` leaves such a token as it is and the
    /// comparator parse then throws. Caret and tilde ignore it.
    misordered: bool,
}

fn part(text: &str) -> Parsed<Part> {
    if matches!(text, "x" | "X" | "*") {
        return Parsed::Valid(Part::Wild);
    }

    match number(text) {
        Parsed::Valid(value) => Parsed::Valid(Part::Number(value)),
        Parsed::Invalid => Parsed::Invalid,
        Parsed::Unsupported => Parsed::Unsupported,
    }
}

/// A word that is not a wildcard (`x`, `X`, possibly after `v`s, which node-semver skips) matches none of the
/// patterns it tries, so its range throws.
fn is_plain_word(text: &str) -> bool {
    !text.is_empty()
        && text.bytes().all(|b| b.is_ascii_alphabetic())
        && !matches!(text.trim_start_matches('v'), "x" | "X")
}

fn parse_partial(text: &str) -> Parsed<Partial> {
    if is_plain_word(text) {
        return Parsed::Invalid;
    }

    // Everything past the first `-` is the pre-release, which only a full version may carry.
    let (core, pre) = match text.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (text, None),
    };

    if !core.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'x' | b'X' | b'*')) {
        return Parsed::Unsupported;
    }

    let pieces: Vec<&str> = core.split('.').collect();

    if pieces.len() > 3 {
        return Parsed::Invalid;
    }

    let mut parts = [Part::Wild; 3];

    for (index, piece) in pieces.iter().enumerate() {
        match part(piece) {
            Parsed::Valid(value) => parts[index] = value,
            Parsed::Invalid => return Parsed::Invalid,
            Parsed::Unsupported => return Parsed::Unsupported,
        }
    }

    let [major, minor, patch] = parts;

    let given = pieces.len();

    let pre = match pre {
        None => Vec::new(),
        Some(pre) if given == 3 && matches!(patch, Part::Number(_)) => match pre_release(pre) {
            Parsed::Valid(pre) => pre,
            Parsed::Invalid | Parsed::Unsupported => return Parsed::Unsupported,
        },
        Some(_) => return Parsed::Unsupported,
    };

    let misordered = (matches!(major, Part::Wild) && given > 1 && !matches!(minor, Part::Wild))
        || (matches!(minor, Part::Wild) && given > 2 && !matches!(patch, Part::Wild));

    Parsed::Valid(Partial { major, minor, patch, pre, misordered })
}

fn version(main: [u64; 3], pre: Vec<Ident>) -> Version {
    Version { main, pre }
}

/// `-0`, the lowest pre-release.
fn zero_pre() -> Vec<Ident> {
    vec![Ident::Num(0)]
}

fn bound(op: Op, main: [u64; 3], pre: Vec<Ident>) -> Comparator {
    Some((op, version(main, pre)))
}

/// `replaceCaret` and `replaceTilde` of node-semver with `includePrerelease`.
fn caret_or_tilde(partial: &Partial, caret: bool) -> Vec<Comparator> {
    let Part::Number(major) = partial.major else {
        return vec![None];
    };

    let Part::Number(minor) = partial.minor else {
        return vec![bound(Op::Ge, [major, 0, 0], zero_pre()), bound(Op::Lt, [major + 1, 0, 0], zero_pre())];
    };

    let Part::Number(patch) = partial.patch else {
        let upper = if caret && major != 0 { [major + 1, 0, 0] } else { [major, minor + 1, 0] };

        return vec![bound(Op::Ge, [major, minor, 0], zero_pre()), bound(Op::Lt, upper, zero_pre())];
    };

    let upper = match (caret, major, minor) {
        (true, 0, 0) => [0, 0, patch + 1],
        (true, 0, _) | (false, ..) => [major, minor + 1, 0],
        (true, ..) => [major + 1, 0, 0],
    };

    vec![bound(Op::Ge, [major, minor, patch], partial.pre.clone()), bound(Op::Lt, upper, zero_pre())]
}

/// `replaceXRange`, with the comparator operator the token carried.
fn x_range(op: &str, partial: &Partial) -> Vec<Comparator> {
    let any_wild = partial.patch.number().is_none();
    let op = if op == "=" && any_wild { "" } else { op };

    let Part::Number(major) = partial.major else {
        return if matches!(op, ">" | "<") { vec![bound(Op::Lt, [0, 0, 0], zero_pre())] } else { vec![None] };
    };

    if !op.is_empty() && any_wild {
        let minor_wild = partial.minor.number().is_none();
        let minor = partial.minor.number().unwrap_or(0);

        let (op, main) = match op {
            ">" if minor_wild => (Op::Ge, [major + 1, 0, 0]),
            ">" => (Op::Ge, [major, minor + 1, 0]),
            "<=" if minor_wild => (Op::Lt, [major + 1, 0, 0]),
            "<=" => (Op::Lt, [major, minor + 1, 0]),
            ">=" => (Op::Ge, [major, minor, 0]),
            _ => (Op::Lt, [major, minor, 0]),
        };

        return vec![bound(op, main, zero_pre())];
    }

    if partial.minor.number().is_none() {
        return vec![bound(Op::Ge, [major, 0, 0], zero_pre()), bound(Op::Lt, [major + 1, 0, 0], zero_pre())];
    }

    let minor = partial.minor.number().unwrap_or(0);

    let Part::Number(patch) = partial.patch else {
        return vec![bound(Op::Ge, [major, minor, 0], zero_pre()), bound(Op::Lt, [major, minor + 1, 0], zero_pre())];
    };

    let op = match op {
        ">=" => Op::Ge,
        ">" => Op::Gt,
        "<=" => Op::Le,
        "<" => Op::Lt,
        _ => Op::Eq,
    };

    vec![bound(op, [major, minor, patch], partial.pre.clone())]
}

/// `hyphenReplace`: `from - to` is `>=from <=to`, with the missing parts of either side taken as wildcards.
fn hyphen(from: &Partial, to: &Partial) -> Vec<Comparator> {
    let mut comparators = Vec::new();

    if let Part::Number(major) = from.major {
        comparators.push(match (from.minor, from.patch) {
            (Part::Wild, _) => bound(Op::Ge, [major, 0, 0], zero_pre()),
            (Part::Number(minor), Part::Wild) => bound(Op::Ge, [major, minor, 0], zero_pre()),
            (Part::Number(minor), Part::Number(patch)) if from.pre.is_empty() => {
                bound(Op::Ge, [major, minor, patch], zero_pre())
            }
            (Part::Number(minor), Part::Number(patch)) => bound(Op::Ge, [major, minor, patch], from.pre.clone()),
        });
    } else {
        comparators.push(None);
    }

    if let Part::Number(major) = to.major {
        comparators.push(match (to.minor, to.patch) {
            (Part::Wild, _) => bound(Op::Lt, [major + 1, 0, 0], zero_pre()),
            (Part::Number(minor), Part::Wild) => bound(Op::Lt, [major, minor + 1, 0], zero_pre()),
            (Part::Number(minor), Part::Number(patch)) if to.pre.is_empty() => {
                bound(Op::Lt, [major, minor, patch + 1], zero_pre())
            }
            (Part::Number(minor), Part::Number(patch)) => bound(Op::Le, [major, minor, patch], to.pre.clone()),
        });
    } else {
        comparators.push(None);
    }

    comparators
}

/// The comparators of a set that is one hyphen range, `Unsupported` for anything else around a ` - `.
fn parse_hyphen(set: &str) -> Parsed<Vec<Comparator>> {
    let Some((from, to)) = set.split_once(" - ") else {
        return Parsed::Unsupported;
    };

    match (parse_partial(from.trim()), parse_partial(to.trim())) {
        (Parsed::Valid(from), Parsed::Valid(to)) => Parsed::Valid(hyphen(&from, &to)),
        _ => Parsed::Unsupported,
    }
}

/// Whether a character can never be part of a node-semver comparator, so that a range holding it is invalid.
fn is_foreign(character: char) -> bool {
    ":/@#(),'\"%!&;?[]{}\\$_`".contains(character)
}

/// The comparators of one space-separated token, `Invalid` when node-semver throws for it.
fn parse_token(token: &str) -> Parsed<Vec<Comparator>> {
    let (op, rest) = if let Some(rest) = token.strip_prefix('^') {
        ("^", rest)
    } else if let Some(rest) = token.strip_prefix('~') {
        ("~", rest)
    } else {
        let length = token.bytes().take_while(|b| matches!(b, b'<' | b'>' | b'=')).count();

        (&token[..length], &token[length..])
    };

    if !matches!(op, "" | "^" | "~" | "=" | ">" | ">=" | "<" | "<=") || rest.is_empty() {
        return if token.bytes().all(|b| b.is_ascii_alphabetic()) { Parsed::Invalid } else { Parsed::Unsupported };
    }

    if rest.starts_with(['v', '=', '>', '~', '^', '<']) {
        return Parsed::Unsupported;
    }

    match parse_partial(rest) {
        Parsed::Valid(partial) => Parsed::Valid(match op {
            "^" => caret_or_tilde(&partial, true),
            "~" => caret_or_tilde(&partial, false),
            _ if partial.misordered => return Parsed::Invalid,
            _ => x_range(op, &partial),
        }),
        Parsed::Invalid => Parsed::Invalid,
        Parsed::Unsupported => Parsed::Unsupported,
    }
}

/// The sets of a range, `||` apart; a version satisfies the range when it satisfies every comparator of one set.
fn parse_range(text: &str) -> Parsed<Vec<Vec<Comparator>>> {
    if !text.is_ascii() {
        return Parsed::Unsupported;
    }

    if text.contains(is_foreign) {
        return Parsed::Invalid;
    }

    if text.bytes().any(|b| b.is_ascii_whitespace() && b != b' ') {
        return Parsed::Unsupported;
    }

    let mut sets = Vec::new();

    for set in text.trim().split("||") {
        let set = set.trim();

        if set.contains(" - ") {
            match parse_hyphen(set) {
                Parsed::Valid(comparators) => sets.push(comparators),
                Parsed::Invalid | Parsed::Unsupported => return Parsed::Unsupported,
            }

            continue;
        }

        let mut comparators = Vec::new();
        let mut tokens = set.split(' ').filter(|token| !token.is_empty()).peekable();

        while let Some(token) = tokens.next() {
            // `COMPARATORTRIM`, `TILDETRIM` and `CARETTRIM`: an operator apart from its version joins it.
            let joined;
            let token = match tokens.peek() {
                Some(next)
                    if matches!(token, ">" | ">=" | "<" | "<=" | "=" | "^" | "~")
                        && next.starts_with(|c: char| c.is_ascii_digit() || matches!(c, 'x' | 'X' | '*')) =>
                {
                    joined = format!("{token}{next}");
                    tokens.next();
                    joined.as_str()
                }
                _ => token,
            };

            match parse_token(token) {
                Parsed::Valid(mut parsed) => comparators.append(&mut parsed),
                Parsed::Invalid => return Parsed::Invalid,
                Parsed::Unsupported => return Parsed::Unsupported,
            }
        }

        if comparators.is_empty() {
            comparators.push(None);
        }

        sets.push(comparators);
    }

    Parsed::Valid(sets)
}

fn satisfies(comparator: &Comparator, candidate: &Version) -> bool {
    let Some((op, bound)) = comparator else {
        return true;
    };

    let ordering = compare(candidate, bound);

    match op {
        Op::Eq => ordering == Ordering::Equal,
        Op::Ge => ordering != Ordering::Less,
        Op::Gt => ordering == Ordering::Greater,
        Op::Le => ordering != Ordering::Greater,
        Op::Lt => ordering == Ordering::Less,
    }
}

/// The index in `versions` of `maxSatisfying(versions, range, { includePrerelease: true })`: the greatest
/// version in the range, the first of equal ones, with entries that are not versions skipped. `Ok(None)` is
/// node-semver's `null`, also for a range it rejects.
pub(super) fn max_satisfying(versions: &[String], range: &str) -> Result<Option<usize>, Unsupported> {
    let sets = match parse_range(range) {
        Parsed::Valid(sets) => sets,
        Parsed::Invalid => return Ok(None),
        Parsed::Unsupported => return Err(Unsupported),
    };

    let mut best: Option<(usize, Version)> = None;

    for (index, text) in versions.iter().enumerate() {
        let candidate = match parse_version(text) {
            Parsed::Valid(candidate) => candidate,
            Parsed::Invalid => continue,
            Parsed::Unsupported => return Err(Unsupported),
        };

        if !sets.iter().any(|set| set.iter().all(|comparator| satisfies(comparator, &candidate))) {
            continue;
        }

        if best.as_ref().is_none_or(|(_, max)| compare(max, &candidate) == Ordering::Less) {
            best = Some((index, candidate));
        }
    }

    Ok(best.map(|(index, _)| index))
}

#[cfg(test)]
mod tests {
    use super::{max_satisfying, Unsupported};

    fn pick(versions: &[&str], range: &str) -> Result<Option<String>, Unsupported> {
        let list: Vec<String> = versions.iter().map(|version| (*version).to_owned()).collect();

        max_satisfying(&list, range).map(|index| index.map(|index| list[index].clone()))
    }

    #[test]
    fn picks_the_greatest_version_in_range() {
        let all = ["1.2.3", "1.9.0", "2.0.0", "2.0.0-beta.1", "0.9.0"];

        assert_eq!(pick(&all, "^1.2.0"), Ok(Some("1.9.0".to_owned())));
        assert_eq!(pick(&all, "~1.2.0"), Ok(Some("1.2.3".to_owned())));
        assert_eq!(pick(&all, ">=1 <2"), Ok(Some("1.9.0".to_owned())));
        assert_eq!(pick(&all, "*"), Ok(Some("2.0.0".to_owned())));
        assert_eq!(pick(&all, ""), Ok(Some("2.0.0".to_owned())));
        assert_eq!(pick(&all, "<1 || 1.2.3"), Ok(Some("1.2.3".to_owned())));
        assert_eq!(pick(&all, "1.2 - 1.9"), Ok(Some("1.9.0".to_owned())));
        assert_eq!(pick(&all, "2.x - 3.x"), Ok(Some("2.0.0".to_owned())));
        // `includePrerelease` lets a pre-release satisfy a range whose bounds name none, but `<2` is `<2.0.0-0`.
        assert_eq!(pick(&["1.9.9-beta"], "<2"), Ok(Some("1.9.9-beta".to_owned())));
        assert_eq!(pick(&["2.0.0-beta.1"], "<2"), Ok(None));
        assert_eq!(pick(&["2.0.0-beta.1"], "^1.0.0"), Ok(None));
    }

    #[test]
    fn a_range_node_semver_rejects_matches_nothing() {
        let all = ["1.0.0"];

        for range in
            ["latest", "next", "workspace:*", "catalog:", "link:../x", "github:a/b", "1.x.3", "01.0.0", "1.2.3.4"]
        {
            assert_eq!(pick(&all, range), Ok(None), "{range}");
        }
    }

    #[test]
    fn a_range_outside_the_grammar_is_unsupported() {
        for range in [
            ">=",
            ">= <2",
            "1 - 2 - 3",
            ">=1 - 2",
            "v1.0.0",
            "~>1.0.0",
            "1.0.0+build",
            "1.2.x-beta",
            "99999999999999999.0.0",
        ] {
            assert_eq!(pick(&["1.0.0"], range), Err(Unsupported), "{range}");
        }
    }

    #[test]
    fn entries_that_are_not_versions_are_skipped() {
        assert_eq!(pick(&["https://x/y.tgz", "1.0.0_peer", "1.0.0"], "*"), Ok(Some("1.0.0".to_owned())));
        assert_eq!(pick(&["v1.0.0"], "*"), Err(Unsupported));
    }

    #[test]
    fn equal_versions_keep_the_first() {
        assert_eq!(pick(&["1.0.0+a", "1.0.0+b"], "*"), Ok(Some("1.0.0+a".to_owned())));
    }

    /// Replays `tests/fixtures/sbom/semver-corpus.json`, which node-semver generated (see the script beside it):
    /// the port either gives node-semver's answer or declines the input (the generator deliberately emits many shapes
    /// outside the grammar), and it must answer more than it declines.
    #[test]
    fn agrees_with_node_semver() {
        let path = std::env::var_os("VIS_SBOM_SEMVER_CORPUS").map(std::path::PathBuf::from).unwrap_or_else(|| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sbom/semver-corpus.json")
        });
        let corpus: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let (mut answered, mut declined) = (0, 0);

        for case in corpus["cases"].as_array().unwrap() {
            let versions: Vec<String> =
                case["versions"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect();
            let range = case["range"].as_str().unwrap();
            let expected = case["expected"].as_str().map(str::to_owned);

            match max_satisfying(&versions, range) {
                Ok(index) => {
                    assert_eq!(index.map(|index| versions[index].clone()), expected, "{versions:?} {range:?}");
                    answered += 1;
                }
                Err(Unsupported) => declined += 1,
            }
        }

        assert!(answered > declined, "answered {answered}, declined {declined}");
    }
}
