//! The command line of `vis inspect`, and which marshalls the run executes.
//!
//! Only the exact tokens are native: one package, `--json`, `--strict` and `--only <list>`, each flag at most once.
//! A value written with `=`, a short flag, a second package and every other flag are Node's.

use std::env;

use crate::js::{trim, PROTOTYPE_NAMES};

/// A marshall `vis inspect` knows, in the order the handler runs them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Marshall {
    Author,
    Provenance,
    S1ngularity,
    NewBin,
    Metadata,
    Downloads,
    ExpiredDomains,
    Signatures,
    ArchivedRepo,
}

const ALL: [Marshall; 9] = [
    Marshall::Author,
    Marshall::Provenance,
    Marshall::S1ngularity,
    Marshall::NewBin,
    Marshall::Metadata,
    Marshall::Downloads,
    Marshall::ExpiredDomains,
    Marshall::Signatures,
    Marshall::ArchivedRepo,
];

impl Marshall {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Author => "author",
            Self::Provenance => "provenance",
            Self::S1ngularity => "s1ngularity",
            Self::NewBin => "newBin",
            Self::Metadata => "metadata",
            Self::Downloads => "downloads",
            Self::ExpiredDomains => "expiredDomains",
            Self::Signatures => "signatures",
            Self::ArchivedRepo => "archivedRepo",
        }
    }

    /// `envVarFor`: `MARSHALL_DISABLE_` and the name with an underscore before each capital, upper-cased.
    fn disable_variable(self) -> String {
        let mut variable = String::from("MARSHALL_DISABLE_");

        for character in self.name().chars() {
            if character.is_ascii_uppercase() {
                variable.push('_');
            }

            variable.push(character.to_ascii_uppercase());
        }

        variable
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Flags {
    pub name: String,
    pub spec: Option<String>,
    pub json: bool,
    pub strict: bool,
    /// The marshalls `--only` names, or `None` for no `--only`.
    pub only: Option<Vec<Marshall>>,
}

/// A segment of a package name: how the registry names a package today.
fn is_name_part(part: &str) -> bool {
    part.bytes().next().is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
        && part
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-'))
}

fn is_name(name: &str) -> bool {
    match name.strip_prefix('@') {
        Some(scoped) => scoped.split_once('/').is_some_and(|(scope, rest)| is_name_part(scope) && is_name_part(rest)),
        None => is_name_part(name),
    }
}

/// `parsePackageArg` for a name and spec in the plain shapes: the name splits at the `@` after its first character,
/// and an empty spec is no spec.
fn parse_package(raw: &str) -> Option<(String, Option<String>)> {
    let separator = raw.get(1..)?.find('@').map(|at| at + 1);
    let (name, spec) = match separator {
        Some(at) => (&raw[..at], Some(&raw[at + 1..]).filter(|spec| !spec.is_empty())),
        None => (raw, None),
    };

    let spec_is_plain = spec.is_none_or(|spec| {
        spec.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'+' | b'-'))
    });

    (is_name(name) && spec_is_plain).then(|| (name.to_owned(), spec.map(str::to_owned)))
}

/// `parseOnlyFlag`: each entry must be a known marshall written plainly. An unknown one is an error Node reports.
fn parse_only(raw: &str) -> Option<Vec<Marshall>> {
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b',') {
        return None;
    }

    raw.split(',').map(|entry| ALL.iter().copied().find(|marshall| marshall.name() == entry)).collect()
}

/// The flags of `vis inspect …`, or the reason the invocation is Node's.
pub(super) fn parse(args: &[String]) -> Result<Flags, String> {
    let [command, rest @ ..] = args else { return Err("no arguments".to_owned()) };

    if command != "inspect" {
        return Err("not `inspect`".to_owned());
    }

    let (mut package, mut json, mut strict, mut only) = (None, false, false, None);
    let mut tokens = rest.iter();

    while let Some(token) = tokens.next() {
        match token.as_str() {
            "--json" if !json => json = true,
            "--strict" if !strict => strict = true,
            "--only" if only.is_none() => {
                let value = tokens.next().ok_or("`--only` without a value")?;

                only = Some(
                    parse_only(value).ok_or_else(|| format!("`--only {value}` is not a list of known marshalls"))?,
                );
            }
            other if !other.starts_with('-') && package.is_none() => {
                package = Some(
                    parse_package(other)
                        .ok_or_else(|| format!("the package {other:?} is not a plain name and spec"))?,
                );
            }
            other => return Err(format!("the argument {other:?} is not one `inspect` answers natively")),
        }
    }

    let (name, spec) = package.ok_or("no package")?;

    Ok(Flags { name, spec, json, strict, only })
}

/// `isTruthyEnv`: set, and not empty, `0`, `false` or `no` once trimmed and lower-cased.
fn is_truthy(value: &str) -> bool {
    !matches!(trim(value).to_lowercase().as_str(), "" | "0" | "false" | "no")
}

/// Whether `MARSHALL_DISABLE_ALL` or the marshall's own variable turns it off. `None` for a value that is not text.
fn is_disabled(marshall: Marshall, lookup: &dyn Fn(&str) -> Option<std::ffi::OsString>) -> Option<bool> {
    for variable in ["MARSHALL_DISABLE_ALL".to_owned(), marshall.disable_variable()] {
        if let Some(value) = lookup(&variable) {
            // `toLowerCase` of a non-ASCII value is not Rust's, so such a value is Node's.
            if is_truthy(value.to_str().filter(|text| text.is_ascii())?) {
                return Some(true);
            }
        }
    }

    Some(false)
}

/// The marshalls the handler runs, in its order: the ones `--only` asks for (all of them but `signatures` without
/// it), less the ones the environment disables. `None` when a variable is not text.
pub(super) fn selected(
    only: Option<&[Marshall]>,
    lookup: &dyn Fn(&str) -> Option<std::ffi::OsString>,
) -> Option<Vec<Marshall>> {
    let mut run = Vec::new();

    for marshall in ALL {
        let asked = match only {
            Some(list) => list.contains(&marshall),
            None => marshall != Marshall::Signatures,
        };

        if asked && !is_disabled(marshall, lookup)? {
            run.push(marshall);
        }
    }

    Some(run)
}

/// The environment of this process.
pub(super) fn process_lookup(name: &str) -> Option<std::ffi::OsString> {
    env::var_os(name)
}

/// Whether `spec` could name an inherited member of a plain object (`toString`), which Node's lookups resolve.
pub(super) fn is_prototype_name(text: &str) -> bool {
    PROTOTYPE_NAMES.contains(&text)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;

    use super::*;

    fn args(words: &[&str]) -> Vec<String> {
        words.iter().map(|word| (*word).to_owned()).collect()
    }

    fn flags(words: &[&str]) -> Flags {
        parse(&args(words)).unwrap()
    }

    #[test]
    fn the_plain_shapes_are_native() {
        let plain = flags(&["inspect", "express"]);

        assert_eq!(
            (plain.name.as_str(), plain.spec, plain.json, plain.strict, plain.only),
            ("express", None, false, false, None)
        );

        let full = flags(&["inspect", "--strict", "@scope/pkg@1.2.3", "--only", "author,newBin", "--json"]);

        assert_eq!(
            (full.name.as_str(), full.spec.as_deref(), full.json, full.strict),
            ("@scope/pkg", Some("1.2.3"), true, true)
        );
        assert_eq!(full.only, Some(vec![Marshall::Author, Marshall::NewBin]));
        assert_eq!(flags(&["inspect", "pkg@"]).spec, None);
        assert_eq!(flags(&["inspect", "@scope/pkg@"]).spec, None);
        assert_eq!(flags(&["inspect", "pkg@beta"]).spec.as_deref(), Some("beta"));
    }

    #[test]
    fn everything_else_is_handed_over() {
        for words in [
            &["inspect"][..],
            &["inspect", "a", "b"],
            &["inspect", "a", "--json", "--json"],
            &["inspect", "a", "--strict", "--strict"],
            &["inspect", "a", "--only"],
            &["inspect", "a", "--only", "--json"],
            &["inspect", "a", "--only", "nope"],
            &["inspect", "a", "--only", "author,"],
            &["inspect", "a", "--only", ""],
            &["inspect", "a", "--only", "author", "--only", "newBin"],
            &["inspect", "a", "--only=author"],
            &["inspect", "a", "--json=true"],
            &["inspect", "a", "-j"],
            &["inspect", "a", "--cwd", "."],
            &["inspect", "a", "--"],
            &["inspect", "A"],
            &["inspect", "a b"],
            &["inspect", "a@^1"],
            &["inspect", "a@1 || 2"],
            &["inspect", "@scope"],
            &["inspect", "@/a"],
            &["inspect", "@a/"],
            &["inspect", "a/b"],
            &["inspect", ".a"],
            &["inspect", "@"],
            &["view", "a"],
        ] {
            assert!(parse(&args(words)).is_err(), "{words:?}");
        }
    }

    fn lookup<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<OsString> + 'a {
        move |name| pairs.iter().find(|(key, _)| *key == name).map(|(_, value)| OsString::from(*value))
    }

    #[test]
    fn the_environment_turns_marshalls_off() {
        let names = |only: Option<&[Marshall]>, pairs: &[(&str, &str)]| -> Vec<&'static str> {
            selected(only, &lookup(pairs)).unwrap().into_iter().map(Marshall::name).collect()
        };

        assert_eq!(
            names(None, &[]),
            [
                "author",
                "provenance",
                "s1ngularity",
                "newBin",
                "metadata",
                "downloads",
                "expiredDomains",
                "archivedRepo"
            ]
        );
        assert_eq!(names(Some(&[Marshall::Signatures, Marshall::Author]), &[]), ["author", "signatures"]);
        assert_eq!(names(None, &[("MARSHALL_DISABLE_ALL", "1")]), Vec::<&str>::new());
        assert_eq!(
            names(
                None,
                &[
                    ("MARSHALL_DISABLE_EXPIRED_DOMAINS", " TRUE "),
                    ("MARSHALL_DISABLE_ARCHIVED_REPO", "yes"),
                    ("MARSHALL_DISABLE_NEW_BIN", "0")
                ]
            ),
            ["author", "provenance", "s1ngularity", "newBin", "metadata", "downloads"]
        );

        for off in ["", "0", "false", "No", "  "] {
            assert_eq!(names(Some(&[Marshall::Author]), &[("MARSHALL_DISABLE_AUTHOR", off)]), ["author"], "{off:?}");
        }

        assert_eq!(Marshall::S1ngularity.disable_variable(), "MARSHALL_DISABLE_S1NGULARITY");
    }
}
