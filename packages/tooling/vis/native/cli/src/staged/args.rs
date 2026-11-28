//! The arguments of `vis staged` the binary answers.
//!
//! The Node command declares seventeen options and reads nine of them. The handler (`handler.ts`) looks the others up
//! under their kebab-case name (`raw["allow-empty"]`), and the parser hands them over under the camelCase one, so
//! `--allow-empty`, `--auto-stage`, `--continue-on-error`, `--fail-on-changes`, `--force-kill`, `--diff-filter` and the
//! two `--hide-*` flags are accepted and then ignored. The binary does not copy that: it hands a call that names one
//! to Node, so the day the handler reads them they do what they say in both.
//!
//! What it reads: `--quiet`, `--verbose`, `--relative`, `--revert`, `--no-stash`, `--concurrent false|<n>` and
//! `--diff <range>`. Anything else (`--cwd`, `--debug`, a value that is not a plain number or `false`, a word that is
//! not an option at all, which the Node parser would reject or read as it sees fit) is Node's.
//!
//! One more rule decides the shape: the run must be one that cannot end in a stack trace. Node prints the stack of the
//! error it raises when the tasks have reverted every staged change (`ApplyEmptyCommitError`), and that stack names
//! the files of the installed bundle. A `--diff` run never makes the check, and `--quiet` (without `--verbose`) keeps
//! the stack off the screen, so one of the two must be given.

/// How many tasks may run at once, as `--concurrent` says.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Concurrency {
    /// No `--concurrent`: as many workers as there are patterns, up to the number of CPUs.
    #[default]
    Default,
    /// `--concurrent false`.
    Serial,
    /// `--concurrent <n>` for a positive integer.
    Limit(usize),
}

/// The options of a run the binary answers.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Options {
    /// `--diff <range>`: the files of a git range instead of the index. Nothing is stashed or re-staged then.
    pub diff: Option<String>,
    pub no_stash: bool,
    pub quiet: bool,
    pub relative: bool,
    pub revert: bool,
    pub verbose: bool,
    pub concurrency: Concurrency,
}

/// A `--concurrent` value the binary reads: `false`, or a plain positive integer (no sign, no leading zero, no
/// exponent), which `Number()` turns into the same integer.
fn concurrency(value: &str) -> Option<Concurrency> {
    if value == "false" {
        return Some(Concurrency::Serial);
    }

    let digits = !value.is_empty() && value.len() <= 6 && value.bytes().all(|byte| byte.is_ascii_digit());

    if !digits || value.starts_with('0') {
        return None;
    }

    value.parse().ok().map(Concurrency::Limit)
}

/// A `--diff` value that is one plain word git reads as a revision or a range (`HEAD`, `main...HEAD`, `origin/main`,
/// `v1.2.0~1`), and that the option parser keeps as a string: it starts with a letter or an underscore, so it is no
/// number, and is none of the words it turns into a value of another type. Node splits the value at white space and
/// hands the words to `git diff`.
fn plain_range(value: &str) -> bool {
    const RESERVED: [&str; 6] = ["false", "infinity", "nan", "null", "true", "undefined"];

    value.starts_with(|first: char| first.is_ascii_alphabetic() || first == '_')
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"_./~^@-".contains(&byte))
        && !RESERVED.contains(&value.to_ascii_lowercase().as_str())
}

/// The options of `args` (`["staged", …]`), or `None` for a call that is Node's.
pub(super) fn parse(args: &[String]) -> Option<Options> {
    let (command, rest) = args.split_first()?;

    if command != "staged" {
        return None;
    }

    let mut options = Options::default();
    let mut seen: Vec<&str> = Vec::new();
    let mut words = rest.iter();

    while let Some(word) = words.next() {
        let (name, inline) = match word.split_once('=') {
            Some((name, value)) if name == "--concurrent" || name == "--diff" => (name, Some(value)),
            _ => (word.as_str(), None),
        };

        // A repeated option is read as a list by the Node parser.
        if seen.contains(&name) {
            return None;
        }

        seen.push(name);

        match name {
            "--no-stash" if inline.is_none() => options.no_stash = true,
            "--quiet" if inline.is_none() => options.quiet = true,
            "--relative" if inline.is_none() => options.relative = true,
            "--revert" if inline.is_none() => options.revert = true,
            "--verbose" if inline.is_none() => options.verbose = true,
            "--concurrent" | "--diff" => {
                let value = match inline {
                    Some(value) => value,
                    None => words.next()?.as_str(),
                };

                if name == "--concurrent" {
                    options.concurrency = concurrency(value)?;
                } else {
                    plain_range(value).then_some(())?;
                    options.diff = Some(value.to_owned());
                }
            }
            _ => return None,
        }
    }

    // See the module documentation: the run must not be able to end in a stack trace.
    let stackless = options.diff.is_some() || (options.quiet && !options.verbose);

    stackless.then_some(options)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn the_listed_options_are_read() {
        let options =
            parse(&argv(&["staged", "--diff", "main...HEAD", "--verbose", "--relative", "--concurrent", "false"]))
                .unwrap();

        assert_eq!(options.diff.as_deref(), Some("main...HEAD"));
        assert!(options.verbose && options.relative);
        assert_eq!(options.concurrency, Concurrency::Serial);
        assert_eq!(parse(&argv(&["staged", "--quiet", "--concurrent=3"])).unwrap().concurrency, Concurrency::Limit(3));
        assert_eq!(parse(&argv(&["staged", "--diff=HEAD~1"])).unwrap().diff.as_deref(), Some("HEAD~1"));
        assert!(parse(&argv(&["staged", "--quiet", "--no-stash", "--revert"])).unwrap().no_stash);
    }

    #[test]
    fn a_run_that_may_end_in_a_stack_trace_is_nodes() {
        assert_eq!(parse(&argv(&["staged"])), None);
        assert_eq!(parse(&argv(&["staged", "--verbose"])), None);
        assert_eq!(parse(&argv(&["staged", "--quiet", "--verbose"])), None);
        assert_eq!(parse(&argv(&["staged", "--relative", "--revert", "--no-stash"])), None);
        assert!(parse(&argv(&["staged", "--quiet"])).is_some());
        assert!(parse(&argv(&["staged", "--quiet", "--verbose", "--diff", "HEAD"])).is_some());
    }

    #[test]
    fn the_options_the_handler_ignores_are_nodes() {
        for flag in [
            "--allow-empty",
            "--auto-stage",
            "--continue-on-error",
            "--fail-on-changes",
            "--force-kill",
            "--hide-unstaged",
            "--hide-partially-staged",
        ] {
            assert_eq!(parse(&argv(&["staged", "--quiet", flag])), None, "{flag}");
        }

        assert_eq!(parse(&argv(&["staged", "--quiet", "--diff-filter", "A"])), None);
    }

    #[test]
    fn every_other_word_is_nodes() {
        for shape in [
            &["staged", "--quiet", "--debug"][..],
            &["staged", "--quiet", "--cwd", "x"],
            &["staged", "--quiet", "--no-color"],
            &["staged", "--quiet", "--stash"],
            &["staged", "--quiet", "-v"],
            &["staged", "--quiet", "extra"],
            &["staged", "--quiet", "--"],
            &["staged", "--quiet", "--quiet"],
            &["staged", "--quiet=false"],
            &["staged", "--quiet", "--concurrent"],
            &["staged", "--quiet", "--concurrent", "true"],
            &["staged", "--quiet", "--concurrent", "0"],
            &["staged", "--quiet", "--concurrent", "02"],
            &["staged", "--quiet", "--concurrent", "-1"],
            &["staged", "--quiet", "--concurrent", "2.5"],
            &["staged", "--quiet", "--concurrent", "1e3"],
            &["staged", "--quiet", "--concurrent", ""],
            &["staged", "--quiet", "--concurrent", "1234567"],
            &["staged", "--quiet", "--diff"],
            &["staged", "--quiet", "--diff", "123"],
            &["staged", "--quiet", "--diff", "true"],
            &["staged", "--quiet", "--diff", "NaN"],
            &["staged", "--quiet", "--diff", "-x"],
            &["staged", "--quiet", "--diff", "HEAD -- src"],
            &["staged", "--quiet", "--diff", "a;b"],
            &["staged", "--quiet", "--diff", ""],
            &["hook", "--quiet"],
        ] {
            assert_eq!(parse(&argv(shape)), None, "{shape:?}");
        }
    }
}
