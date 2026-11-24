use std::str::FromStr;

use super::types::{ConcurrentCloseEvent, InvalidOption};

/// Determines what constitutes a successful run.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum SuccessCondition {
    /// All commands must exit with code 0.
    #[default]
    All,
    /// Only the first command to close must succeed.
    First,
    /// Only the last command to close must succeed.
    Last,
    /// Only the specified command (by name or index) must succeed.
    Command(String),
    /// All commands except the specified one must succeed.
    NegatedCommand(String),
}

impl FromStr for SuccessCondition {
    type Err = InvalidOption;

    /// Formats: "all", "first", "last", "command-<name|index>", "!command-<name|index>".
    ///
    /// The keywords are case-insensitive; the name after `command-` keeps its
    /// case, because it is compared with the command's own name.
    fn from_str(input: &str) -> Result<Self, Self::Err> {
        let trimmed = input.trim();
        let lower = trimmed.to_ascii_lowercase();

        let target = |prefix: &str| (trimmed.len() > prefix.len()).then(|| trimmed[prefix.len()..].to_string());

        match lower.as_str() {
            "all" => Ok(Self::All),
            "first" => Ok(Self::First),
            "last" => Ok(Self::Last),
            s if s.starts_with("!command-") => {
                target("!command-").map(Self::NegatedCommand).ok_or_else(|| Self::invalid(input))
            }
            s if s.starts_with("command-") => target("command-").map(Self::Command).ok_or_else(|| Self::invalid(input)),
            _ => Err(Self::invalid(input)),
        }
    }
}

impl SuccessCondition {
    fn invalid(value: &str) -> InvalidOption {
        InvalidOption {
            option: "successCondition",
            value: value.to_string(),
            expected: "\"all\", \"first\", \"last\", \"command-<name|index>\" or \"!command-<name|index>\"",
        }
    }

    /// Evaluate whether the run succeeded given the close events (in completion order).
    pub(crate) fn evaluate(&self, events: &[ConcurrentCloseEvent]) -> bool {
        if events.is_empty() {
            return true;
        }

        match self {
            Self::All => events.iter().all(|e| e.exit_code == 0),
            Self::First => events.first().is_none_or(|e| e.exit_code == 0),
            Self::Last => events.last().is_none_or(|e| e.exit_code == 0),
            Self::Command(target) => {
                let matching: Vec<_> = events.iter().filter(|e| Self::matches_target(e, target)).collect();

                if matching.is_empty() {
                    false
                } else {
                    matching.iter().all(|e| e.exit_code == 0)
                }
            }
            Self::NegatedCommand(target) => {
                events.iter().filter(|e| !Self::matches_target(e, target)).all(|e| e.exit_code == 0)
            }
        }
    }

    /// Check if a close event matches the target (by name or index string).
    fn matches_target(event: &ConcurrentCloseEvent, target: &str) -> bool {
        // Match by name
        if let Some(ref name) = event.name {
            if name == target {
                return true;
            }
        }
        // Match by index
        if let Ok(idx) = target.parse::<u32>() {
            return event.index == idx;
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_event(index: u32, name: Option<&str>, exit_code: i32) -> ConcurrentCloseEvent {
        ConcurrentCloseEvent {
            index,
            command: format!("cmd-{}", index),
            name: name.map(|s| s.to_string()),
            exit_code,
            killed: false,
            duration_ms: 100.0,
        }
    }

    #[test]
    fn test_all_success() {
        let cond = SuccessCondition::All;
        let events = vec![make_event(0, None, 0), make_event(1, None, 0)];
        assert!(cond.evaluate(&events));
    }

    #[test]
    fn test_all_failure() {
        let cond = SuccessCondition::All;
        let events = vec![make_event(0, None, 0), make_event(1, None, 1)];
        assert!(!cond.evaluate(&events));
    }

    #[test]
    fn test_first() {
        let cond = SuccessCondition::First;
        let events = vec![make_event(0, None, 0), make_event(1, None, 1)];
        assert!(cond.evaluate(&events));
    }

    #[test]
    fn test_first_failure() {
        let cond = SuccessCondition::First;
        let events = vec![make_event(0, None, 1), make_event(1, None, 0)];
        assert!(!cond.evaluate(&events));
    }

    #[test]
    fn test_last() {
        let cond = SuccessCondition::Last;
        let events = vec![make_event(0, None, 1), make_event(1, None, 0)];
        assert!(cond.evaluate(&events));
    }

    #[test]
    fn test_command_by_name() {
        let cond = SuccessCondition::Command("server".to_string());
        let events = vec![make_event(0, Some("server"), 0), make_event(1, Some("client"), 1)];
        assert!(cond.evaluate(&events));
    }

    #[test]
    fn test_command_by_index() {
        let cond = SuccessCondition::Command("1".to_string());
        let events = vec![make_event(0, None, 1), make_event(1, None, 0)];
        assert!(cond.evaluate(&events));
    }

    #[test]
    fn test_negated_command() {
        let cond = SuccessCondition::NegatedCommand("server".to_string());
        let events = vec![make_event(0, Some("server"), 1), make_event(1, Some("client"), 0)];
        assert!(cond.evaluate(&events));
    }

    fn parse(input: &str) -> SuccessCondition {
        input.parse().unwrap()
    }

    #[test]
    fn test_parse() {
        assert_eq!(parse("all"), SuccessCondition::All);
        assert_eq!(parse("first"), SuccessCondition::First);
        assert_eq!(parse("last"), SuccessCondition::Last);
        assert_eq!(parse("command-server"), SuccessCondition::Command("server".to_string()));
        assert_eq!(parse("!command-server"), SuccessCondition::NegatedCommand("server".to_string()));
    }

    #[test]
    fn test_empty_events() {
        assert!(SuccessCondition::All.evaluate(&[]));
        assert!(SuccessCondition::First.evaluate(&[]));
        assert!(SuccessCondition::Last.evaluate(&[]));
    }

    #[test]
    fn test_command_not_found_returns_false() {
        let cond = SuccessCondition::Command("nonexistent".to_string());
        let events = vec![make_event(0, Some("server"), 0)];
        assert!(!cond.evaluate(&events));
    }

    #[test]
    fn test_command_multiple_matching() {
        // Two commands with the same name, both must succeed
        let cond = SuccessCondition::Command("worker".to_string());
        let events = vec![make_event(0, Some("worker"), 0), make_event(1, Some("worker"), 0)];
        assert!(cond.evaluate(&events));
    }

    #[test]
    fn test_command_multiple_matching_one_fails() {
        let cond = SuccessCondition::Command("worker".to_string());
        let events = vec![make_event(0, Some("worker"), 0), make_event(1, Some("worker"), 1)];
        assert!(!cond.evaluate(&events));
    }

    #[test]
    fn test_negated_all_excluded() {
        // If all events match the target, no events remain to check -- vacuous truth
        let cond = SuccessCondition::NegatedCommand("only".to_string());
        let events = vec![make_event(0, Some("only"), 1)];
        assert!(cond.evaluate(&events));
    }

    #[test]
    fn test_all_single_failure() {
        let cond = SuccessCondition::All;
        let events = vec![make_event(0, None, 1)];
        assert!(!cond.evaluate(&events));
    }

    #[test]
    fn test_all_single_success() {
        let cond = SuccessCondition::All;
        let events = vec![make_event(0, None, 0)];
        assert!(cond.evaluate(&events));
    }

    #[test]
    fn test_parse_keywords_are_case_insensitive() {
        assert_eq!(parse("ALL"), SuccessCondition::All);
        assert_eq!(parse("First"), SuccessCondition::First);
        assert_eq!(parse("LAST"), SuccessCondition::Last);
        assert_eq!(parse("COMMAND-x"), SuccessCondition::Command("x".to_string()));
        assert_eq!(parse("!Command-x"), SuccessCondition::NegatedCommand("x".to_string()));
    }

    #[test]
    fn test_parse_keeps_the_case_of_the_command_name() {
        assert_eq!(parse("command-MyApp"), SuccessCondition::Command("MyApp".to_string()));
        assert_eq!(parse("!command-MyApp"), SuccessCondition::NegatedCommand("MyApp".to_string()));

        let events = vec![make_event(0, Some("MyApp"), 0), make_event(1, Some("other"), 3)];

        assert!(parse("command-MyApp").evaluate(&events));
        assert!(!parse("command-myapp").evaluate(&events));
        assert!(parse("!command-other").evaluate(&events));
    }

    #[test]
    fn test_parse_with_whitespace() {
        assert_eq!(parse("  all  "), SuccessCondition::All);
    }

    #[test]
    fn test_parse_rejects_unknown_values_and_names_them() {
        for value in ["unknown", "", "command-", "!command-", "commands-x"] {
            let error = value.parse::<SuccessCondition>().unwrap_err();

            assert_eq!(error.option, "successCondition");
            assert_eq!(error.value, value);
            assert!(error.to_string().contains(&format!("{value:?}")), "{error}");
        }
    }

    #[test]
    fn test_killed_processes_have_nonzero_exit() {
        let cond = SuccessCondition::All;
        let mut event = make_event(0, None, -9);
        event.killed = true;
        assert!(!cond.evaluate(&[event]));
    }

    #[test]
    fn test_command_by_index_with_named_events() {
        // Index matching should work even when events have names
        let cond = SuccessCondition::Command("0".to_string());
        let events = vec![make_event(0, Some("server"), 0), make_event(1, Some("client"), 1)];
        assert!(cond.evaluate(&events));
    }

    #[test]
    fn test_last_with_many_events() {
        let cond = SuccessCondition::Last;
        let events = vec![
            make_event(0, None, 1),
            make_event(1, None, 1),
            make_event(2, None, 1),
            make_event(3, None, 0), // last one succeeds
        ];
        assert!(cond.evaluate(&events));
    }
}
