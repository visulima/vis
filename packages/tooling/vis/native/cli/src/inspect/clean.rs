//! Whether the marshalls that read a packument and nothing else find anything for `name@version`: the five `vis inspect`
//! runs, and `deprecation` and `packageAge`, which `vis add` runs as well.
//!
//! `vis add` does not print a finding of its own: it shows a table and may prompt, which is Node's. What it needs is
//! whether there is one, so each check answers with that, and `Err` for every shape the checks do not read as Node does.

use super::js_format::parse_date;
use super::marshalls::{author_in_pipeline, metadata, new_bin, provenance, s1ngularity, Target};
use super::packument::View;
use crate::keys_refresh::Js;

/// The checks to run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Checks {
    pub(crate) author: bool,
    pub(crate) provenance: bool,
    pub(crate) s1ngularity: bool,
    pub(crate) new_bin: bool,
    pub(crate) metadata: bool,
    pub(crate) deprecation: bool,
    pub(crate) package_age: bool,
}

/// The entry `versions[version] ?? versions[latest]` of the marshalls that fall back to the newest release: the `latest`
/// tag when it names a version, else the last one.
pub(crate) fn entry_or_latest<'a>(view: &View<'a>, version: &str) -> Result<Option<&'a Js>, String> {
    if let Some(entry) = view.entry(version) {
        return Ok(Some(entry));
    }

    let latest = view.tag("latest")?.filter(|tag| view.entry(tag).is_some()).or_else(|| view.last_version());

    Ok(latest.and_then(|tag| view.entry(tag)))
}

/// `sanitizeReason(deprecated) !== ""`: whether the text holds anything but whitespace and control characters. Only
/// ASCII is decided here (JavaScript's `\s` and `\p{Cc}` are not Rust's beyond it).
fn deprecation_reason_is_empty(text: &str) -> Result<bool, String> {
    if !text.is_ascii() {
        return Err("a `deprecated` text that is not ASCII".to_owned());
    }

    Ok(text.bytes().all(|byte| byte.is_ascii_control() || byte == b' '))
}

fn deprecated(view: &View, version: &str) -> Result<bool, String> {
    let Some(entry) = entry_or_latest(view, version)? else { return Ok(false) };

    match entry.member("deprecated") {
        Some(Js::String(text)) => Ok(!deprecation_reason_is_empty(text)?),
        _ => Ok(false),
    }
}

const MS_PER_DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
const NEW_PACKAGE_DAYS: f64 = 22.0;
const UNMAINTAINED_DAYS: f64 = 365.0;

/// `Date.parse(value)` of a time: `None` for text that is not a date at all, `Err` for a form this does not read.
fn parse_time(text: &str) -> Result<Option<f64>, String> {
    if text.is_empty() {
        return Ok(None);
    }

    parse_date(text).map(Some).ok_or_else(|| format!("a time {text:?} in a form this binary does not parse"))
}

/// The package-age checks: first published less than 22 days ago, or last published more than 365 days ago.
fn too_young_or_idle(view: &View, now_ms: f64) -> Result<bool, String> {
    let mut stamps = Vec::new();

    for (key, value) in view.time_entries() {
        if key == "created" || key == "modified" {
            continue;
        }

        let Js::String(text) = value else { return Err("a version time that is not text".to_owned()) };

        stamps.extend(parse_time(text)?);
    }

    let named = |key: &str| -> Result<Option<f64>, String> { view.time(key)?.map_or(Ok(None), parse_time) };
    let created = match named("created")? {
        Some(created) => Some(created),
        None => stamps.iter().copied().reduce(f64::min),
    };

    if created.is_some_and(|created| (now_ms - created) / MS_PER_DAY < NEW_PACKAGE_DAYS) {
        return Ok(true);
    }

    let modified = match named("modified")? {
        Some(modified) => Some(modified),
        None => stamps.iter().copied().reduce(f64::max),
    };

    Ok(modified.is_some_and(|modified| (now_ms - modified) / MS_PER_DAY > UNMAINTAINED_DAYS))
}

/// The first check that finds something for `name@version` in the packument, by its name (`None`: the registry does not
/// know the package, which no check reports, or no check finds anything).
pub(crate) fn first_finding(
    view: Option<&View>,
    name: &str,
    version: &str,
    now_ms: u64,
    checks: Checks,
) -> Result<Option<&'static str>, String> {
    let Some(view) = view else { return Ok(None) };
    let target = Target { name, version };
    let now = now_ms as f64;

    let found = if checks.author && author_in_pipeline(view, &target)? {
        "author"
    } else if checks.provenance && !provenance(view, &target)?.is_empty() {
        "provenance"
    } else if checks.s1ngularity && !s1ngularity(view, &target)?.is_empty() {
        "s1ngularity"
    } else if checks.new_bin && !new_bin(view, &target)?.is_empty() {
        "newBin"
    } else if checks.metadata && !metadata(view, &target)?.is_empty() {
        "metadata"
    } else if checks.deprecation && deprecated(view, version)? {
        "deprecation"
    } else if checks.package_age && too_young_or_idle(view, now)? {
        "packageAge"
    } else {
        return Ok(None);
    };

    Ok(Some(found))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_718_452_800_000;

    fn parse(text: &str) -> Js {
        serde_json::from_str(text).unwrap()
    }

    fn view_of(js: &Js) -> View<'_> {
        View::new(js).unwrap()
    }

    fn only(set: impl FnOnce(&mut Checks)) -> Checks {
        let mut checks = Checks::default();

        set(&mut checks);

        checks
    }

    #[test]
    fn a_deprecation_with_a_reason_is_a_finding_and_one_that_is_blank_is_not() {
        let check = only(|checks| checks.deprecation = true);
        let found = |body: &str, version: &str| {
            let js = parse(body);

            first_finding(Some(&view_of(&js)), "p", version, NOW, check).map(|found| found.is_some())
        };
        let deprecated =
            r#"{"name":"p","versions":{"1.0.0":{"deprecated":"use q"},"2.0.0":{}},"dist-tags":{"latest":"2.0.0"}}"#;

        assert_eq!(found(deprecated, "1.0.0"), Ok(true));
        assert_eq!(found(deprecated, "2.0.0"), Ok(false));
        // A version the packument lacks reads the latest one.
        assert_eq!(found(deprecated, "9.9.9"), Ok(false));
        assert_eq!(
            found(
                r#"{"name":"p","versions":{"1.0.0":{"deprecated":"use q"}},"dist-tags":{"latest":"1.0.0"}}"#,
                "9.9.9"
            ),
            Ok(true)
        );
        // Whitespace and control characters alone are no reason.
        for blank in ["", " ", "\\t\\n \\u0007"] {
            assert_eq!(
                found(&format!(r#"{{"name":"p","versions":{{"1.0.0":{{"deprecated":"{blank}"}}}}}}"#), "1.0.0"),
                Ok(false),
                "{blank:?}"
            );
        }
        assert!(found(r#"{"name":"p","versions":{"1.0.0":{"deprecated":"café"}}}"#, "1.0.0").is_err());
        assert_eq!(first_finding(None, "p", "1.0.0", NOW, check), Ok(None));
    }

    #[test]
    fn a_new_package_or_one_that_has_been_idle_for_a_year_is_a_finding() {
        let check = only(|checks| checks.package_age = true);
        let ago = |days: f64| {
            let ms = NOW as f64 - days * MS_PER_DAY;
            let seconds = (ms / 1000.0) as i64;
            let (year_day, rest) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
            let shifted = year_day + 719_468;
            let era = shifted.div_euclid(146_097);
            let day_of_era = shifted - era * 146_097;
            let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
            let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
            let month_index = (5 * day_of_year + 2) / 153;
            let day = day_of_year - (153 * month_index + 2) / 5 + 1;
            let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
            let year = year_of_era + era * 400 + i64::from(month <= 2);

            format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z", rest / 3600, rest / 60 % 60, rest % 60)
        };
        let found = |time: &str| {
            let js = parse(&format!(r#"{{"name":"p","versions":{{"1.0.0":{{}}}},"time":{time}}}"#));

            first_finding(Some(&view_of(&js)), "p", "1.0.0", NOW, check).map(|found| found.is_some())
        };

        assert_eq!(found(&format!(r#"{{"created":"{}","modified":"{}"}}"#, ago(500.0), ago(10.0))), Ok(false));
        assert_eq!(found(&format!(r#"{{"created":"{}","modified":"{}"}}"#, ago(21.0), ago(10.0))), Ok(true));
        assert_eq!(found(&format!(r#"{{"created":"{}","modified":"{}"}}"#, ago(500.0), ago(366.0))), Ok(true));
        assert_eq!(found(&format!(r#"{{"created":"{}","modified":"{}"}}"#, ago(500.0), ago(364.0))), Ok(false));
        // Without `created` and `modified` the version times stand in for them.
        assert_eq!(found(&format!(r#"{{"1.0.0":"{}","1.1.0":"{}"}}"#, ago(500.0), ago(10.0))), Ok(false));
        assert_eq!(found(&format!(r#"{{"1.0.0":"{}"}}"#, ago(5.0))), Ok(true));
        assert_eq!(found("{}"), Ok(false));
        // A form this does not parse, or a time that is not text, is Node's.
        assert!(found(r#"{"created":"2024-01-01"}"#).is_err());
        assert!(found(r#"{"1.0.0":5}"#).is_err());
    }

    #[test]
    fn the_author_check_is_the_one_the_add_pipeline_runs() {
        let check = only(|checks| checks.author = true);
        let user = |name: &str| format!(r#"{{"_npmUser":{{"name":"{name}"}}}}"#);
        let found = |versions: &[(&str, &str, &str)], version: &str| {
            let entries: Vec<String> = versions.iter().map(|(v, who, _)| format!(r#""{v}":{}"#, user(who))).collect();
            let times: Vec<String> = versions.iter().map(|(v, _, time)| format!(r#""{v}":"{time}""#)).collect();
            let js = parse(&format!(
                r#"{{"name":"p","versions":{{{}}},"time":{{{}}}}}"#,
                entries.join(","),
                times.join(",")
            ));

            first_finding(Some(&view_of(&js)), "p", version, NOW, check).map(|found| found.is_some())
        };
        let (old, recent) = ("2020-01-01T00:00:00.000Z", "2024-06-14T00:00:00.000Z");

        // A first publish by someone new reports, however young the package: the window that would excuse it is `undefined`.
        assert_eq!(found(&[("1.0.0", "amy", recent), ("1.1.0", "bob", recent)], "1.1.0"), Ok(true));
        assert_eq!(found(&[("1.0.0", "amy", old), ("1.1.0", "bob", old)], "1.1.0"), Ok(true));
        // The same publisher, a brand-new package, and a version nobody published before it do not.
        assert_eq!(found(&[("1.0.0", "amy", old), ("1.1.0", "amy", old)], "1.1.0"), Ok(false));
        assert_eq!(found(&[("1.0.0", "amy", old)], "1.0.0"), Ok(false));
        // A release published yesterday, and one whose maintainer was away for years, do not report either: their
        // thresholds are `undefined` too.
        assert_eq!(found(&[("1.0.0", "amy", old), ("1.1.0", "amy", recent)], "1.1.0"), Ok(false));
        assert_eq!(found(&[("1.0.0", "amy", old), ("1.1.0", "amy", "2024-06-15T00:00:00.000Z")], "1.1.0"), Ok(false));
    }

    #[test]
    fn the_checks_that_are_off_find_nothing() {
        let js = parse(r#"{"name":"p","versions":{"1.0.0":{"deprecated":"x"}}}"#);

        assert_eq!(first_finding(Some(&view_of(&js)), "p", "1.0.0", NOW, Checks::default()), Ok(None));
    }
}
