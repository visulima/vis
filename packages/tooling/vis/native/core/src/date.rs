//! Calendar arithmetic shared by the CLI and the addon, so a timestamp is built one way everywhere.

/// The civil date `(year, month, day)` of a day count since 1970-01-01 (Howard Hinnant's `civil_from_days`).
#[must_use]
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let shifted = days + 719_468;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };

    (year_of_era + era * 400 + i64::from(month <= 2), month, day)
}

/// `new Date(milliseconds).toISOString()` for a time in the years 0000 to 9999.
#[must_use]
pub fn iso_from_millis(milliseconds: i64) -> String {
    let (year, month, day) = civil_from_days(milliseconds.div_euclid(86_400_000));
    let of_day = milliseconds.rem_euclid(86_400_000);

    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3_600_000,
        of_day / 60_000 % 60,
        of_day / 1000 % 60,
        of_day % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_dates_around_the_epoch_and_a_leap_day() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        assert_eq!(civil_from_days(19_783), (2024, 3, 1));
    }

    #[test]
    fn iso_matches_to_iso_string() {
        assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_from_millis(1_705_322_096_789), "2024-01-15T12:34:56.789Z");
        assert_eq!(iso_from_millis(253_402_300_799_999), "9999-12-31T23:59:59.999Z");
    }
}
