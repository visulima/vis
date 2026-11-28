//! The arguments of `vis check` this port answers. Everything else (`--ai`, `--ai-type`, `--security-config`,
//! `--sync`, `--include-internal`, a flag written with `=`, a repeated flag, an option the command does not have) is
//! Node's. `--include-internal` is declared, but the output of Node is the same with and without it (the handler reads
//! it under the key `include-internal`), so whatever Node does with it, now or once that changes, stays Node's.
//!
//! Each flag is read from its exact tokens and is accepted at most once: cerebro turns a repeated boolean into a
//! list and a repeated string into its last value, neither of which this port reproduces. `--include` and `--exclude`
//! are the two options that may repeat. A word right after the value of one of them is left to Node, because
//! cerebro reads it as another value of that option (`--exclude a b` excludes both) where it reads it as a package
//! pattern after any other flag.

use super::version::Target;

/// `--format`. A value outside these is Node's: it prints the table for any it does not know.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Format {
    Table,
    Json,
    Minimal,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Flags {
    pub(super) dev: bool,
    pub(super) exit_code: bool,
    pub(super) no_security: bool,
    pub(super) peer: bool,
    pub(super) prerelease: bool,
    pub(super) prod: bool,
    pub(super) exclude: Vec<String>,
    pub(super) include: Vec<String>,
    pub(super) format: Option<Format>,
    pub(super) target: Option<Target>,
    /// The package patterns after the command, which Node adds to `--include`.
    pub(super) packages: Vec<String>,
}

/// A pattern or value: printable ASCII with no space, not a flag. Node reads every other text through a regular
/// expression over UTF-16 code units, which this port reproduces for ASCII only.
fn plain(value: &str) -> bool {
    !value.is_empty() && !value.starts_with('-') && value.bytes().all(|byte| byte.is_ascii_graphic())
}

/// The flags of `args` (`check` or `c`, then the rest), or `None` for a shape Node answers.
pub(super) fn parse(args: &[String]) -> Option<Flags> {
    if !matches!(args.first().map(String::as_str), Some("check" | "c")) {
        return None;
    }

    let mut flags = Flags::default();
    let mut seen: Vec<&'static str> = Vec::new();
    let mut after_multi_value = false;
    let mut index = 1;

    while index < args.len() {
        let token = args[index].as_str();
        let was_after_multi_value = std::mem::take(&mut after_multi_value);

        let key = match token {
            "-D" | "--dev" => {
                flags.dev = true;
                "dev"
            }
            "-P" | "--prod" => {
                flags.prod = true;
                "prod"
            }
            "--peer" => {
                flags.peer = true;
                "peer"
            }
            "--prerelease" => {
                flags.prerelease = true;
                "prerelease"
            }
            "--exit-code" => {
                flags.exit_code = true;
                "exit-code"
            }
            "--no-security" => {
                flags.no_security = true;
                "no-security"
            }
            "--format" => {
                index += 1;
                flags.format = Some(match args.get(index)?.as_str() {
                    "table" => Format::Table,
                    "json" => Format::Json,
                    "minimal" => Format::Minimal,
                    _ => return None,
                });
                "format"
            }
            "-t" | "--target" => {
                index += 1;
                flags.target = Some(match args.get(index)?.as_str() {
                    "latest" => Target::Latest,
                    "minor" => Target::Minor,
                    "patch" => Target::Patch,
                    _ => return None,
                });
                "target"
            }
            "--include" | "--exclude" => {
                index += 1;

                let value = args.get(index)?;

                if !plain(value) {
                    return None;
                }

                if token == "--include" {
                    flags.include.push(value.clone());
                } else {
                    flags.exclude.push(value.clone());
                }

                after_multi_value = true;
                index += 1;

                continue;
            }
            _ if token.starts_with('-') => return None,
            _ => {
                if was_after_multi_value || !plain(token) {
                    return None;
                }

                flags.packages.push(token.to_owned());
                index += 1;

                continue;
            }
        };

        if seen.contains(&key) {
            return None;
        }

        seen.push(key);
        index += 1;
    }

    // cerebro rejects the pair with an error of its own.
    if flags.dev && flags.prod {
        return None;
    }

    Some(flags)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn the_flags_and_packages_this_port_answers_parse() {
        let flags = parse(&tokens(&[
            "check",
            "react",
            "--format",
            "json",
            "-t",
            "patch",
            "--include",
            "@a/*",
            "--exclude",
            "x",
            "--exclude",
            "y",
            "-D",
            "--exit-code",
            "--no-security",
            "--peer",
            "--prerelease",
        ]))
        .expect("parses");

        assert_eq!(
            flags,
            Flags {
                dev: true,
                exit_code: true,
                no_security: true,
                peer: true,
                prerelease: true,
                exclude: vec!["x".into(), "y".into()],
                include: vec!["@a/*".into()],
                format: Some(Format::Json),
                target: Some(Target::Patch),
                packages: vec!["react".into()],
                ..Flags::default()
            }
        );
        assert!(parse(&tokens(&["c"])).is_some());
        assert!(parse(&tokens(&["check", "--prod", "calm"])).is_some());
        assert!(parse(&tokens(&["check", "--format", "table", "calm"])).is_some());
    }

    #[test]
    fn everything_else_is_left_to_node() {
        for rest in [
            &["--ai"][..],
            &["--ai-type", "impact"],
            &["--security-config"],
            &["--sync"],
            // The flag changes nothing in Node today; whatever Node does with it later stays Node's.
            &["--include-internal"],
            &["--format=json"],
            &["--target=patch"],
            &["--include=a"],
            &["--exit-code=false"],
            &["--format", "xml"],
            &["--format"],
            &["--target", "bad"],
            &["--dev", "--prod"],
            &["-D", "-P"],
            &["--exit-code", "--exit-code"],
            &["--format", "json", "--format", "table"],
            &["--target", "minor", "--target", "patch"],
            &["--include", ""],
            &["--include", "-x"],
            &["--exclude", "a", "b"],
            &["--include", "a", "b"],
            &["--include", "a b"],
            &["--include"],
            &["--no-color"],
            &["--"],
            &["-Dg"],
            &["ré"],
            &["a b"],
        ] {
            let mut list = vec!["check"];

            list.extend_from_slice(rest);

            assert!(parse(&tokens(&list)).is_none(), "{rest:?}");
        }

        assert!(parse(&tokens(&["outdated"])).is_none());
        assert!(parse(&tokens(&[])).is_none());
    }
}
