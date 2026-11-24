//! What the `hook` commands share: the hooks directory, the standard stages and the arguments that name them.

pub(super) const DEFAULT_HOOKS_DIRECTORY: &str = ".vis/hooks";

/// The standard git hooks, `HOOKS` in `src/commands/hook/constants.ts`. Sorted by byte order, which is also the
/// order `localeCompare` gives these names (the parity suite lists all of them).
pub(super) const STAGES: [&str; 14] = [
    "applypatch-msg",
    "commit-msg",
    "post-applypatch",
    "post-checkout",
    "post-commit",
    "post-merge",
    "post-rewrite",
    "pre-applypatch",
    "pre-auto-gc",
    "pre-commit",
    "pre-merge-commit",
    "pre-push",
    "pre-rebase",
    "prepare-commit-msg",
];

/// The hooks directory the arguments of `hook <subcommand>` ask for, or `None` when the invocation is not a shape this
/// module (or `validate`, which takes the same option) answers.
pub(super) fn parse(args: &[String], subcommand: &str) -> Option<String> {
    match args {
        [command, name] if command == "hook" && name == subcommand => Some(DEFAULT_HOOKS_DIRECTORY.to_owned()),
        [command, name, flag, value] if command == "hook" && name == subcommand && flag == "--hooks-dir" => {
            is_plain_directory(value).then(|| value.clone())
        }
        [command, name, flag] if command == "hook" && name == subcommand => {
            let value = flag.strip_prefix("--hooks-dir=")?;

            is_plain_directory(value).then(|| value.to_owned())
        }
        _ => None,
    }
}

/// A relative path of plain segments that the argument parser keeps as the string it is: no segment is empty, `.`
/// or `..` (the handler normalises the path it reads and prints the one it was given), and the value could not be
/// read as a number, a boolean or a flag.
fn is_plain_directory(value: &str) -> bool {
    let first = value.chars().next();
    let starts_plain = first.is_some_and(|character| character.is_ascii_alphabetic() || character == '_')
        || (first == Some('.')
            && value.chars().nth(1).is_some_and(|character| character.is_ascii_alphabetic() || character == '_'));
    let reserved = ["true", "false", "null", "undefined", "nan", "infinity"];

    starts_plain
        && !reserved.iter().any(|word| value.eq_ignore_ascii_case(word))
        && value.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        })
}
