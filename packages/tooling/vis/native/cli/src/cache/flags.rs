//! The flag syntax the native cache commands accept: `--name value` and `--name=value`, each flag once, with a value
//! that does not start like another flag.

/// `--name=value` as `("--name", Some("value"))`, and a token without `=` as itself.
pub(crate) fn split(token: &str) -> (&str, Option<&str>) {
    match token.split_once('=') {
        Some((name, value)) => (name, Some(value)),
        None => (token, None),
    }
}

/// Reads the value of a flag into `slot`: the inline one, else the next token. `None` for a shape cerebro interprets:
/// a missing, empty or dash-led value, and a flag given twice (an array there).
pub(crate) fn take_value<'a>(
    slot: &mut Option<&'a str>,
    inline: Option<&'a str>,
    tokens: &mut impl Iterator<Item = &'a String>,
) -> Option<()> {
    let value = match inline {
        Some(value) => value,
        None => tokens.next()?.as_str(),
    };

    if slot.is_some() || value.is_empty() || value.starts_with('-') {
        return None;
    }

    *slot = Some(value);

    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read<'a>(args: &'a [String], inline: Option<&'a str>) -> Option<Option<&'a str>> {
        let mut slot = None;
        let mut tokens = args.iter();

        take_value(&mut slot, inline, &mut tokens)?;

        Some(slot)
    }

    #[test]
    fn a_flag_splits_at_the_first_equals_sign() {
        assert_eq!(split("--format=json"), ("--format", Some("json")));
        assert_eq!(split("--cache-dir=a=b"), ("--cache-dir", Some("a=b")));
        assert_eq!(split("--format"), ("--format", None));
    }

    #[test]
    fn the_value_is_inline_or_the_next_token() {
        let next = ["json".to_owned()];

        assert_eq!(read(&next, None), Some(Some("json")));
        assert_eq!(read(&next, Some("table")), Some(Some("table")));
    }

    #[test]
    fn a_missing_empty_or_dash_led_value_is_cerebros() {
        let (dash, empty) = (["-x".to_owned()], [String::new()]);

        assert_eq!(read(&[], None), None);
        assert_eq!(read(&dash, None), None);
        assert_eq!(read(&empty, None), None);
        assert_eq!(read(&[], Some("")), None);
        assert_eq!(read(&[], Some("-x")), None);
    }

    #[test]
    fn a_repeated_flag_is_cerebros() {
        let mut slot = Some("json");

        assert_eq!(take_value(&mut slot, Some("table"), &mut [].iter()), None);
        assert_eq!(slot, Some("json"));
    }
}
