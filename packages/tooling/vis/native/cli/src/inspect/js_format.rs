//! Two JavaScript behaviours the author marshall's messages depend on: `new Date(text).getTime()` for the one form
//! registries write, and `Number.prototype.toFixed`.

/// `Date.parse` of `YYYY-MM-DDTHH:MM:SS.sssZ` in milliseconds since the epoch. Any other text, and a field out of range,
/// is `None`: `Date` reads many other forms (and the legacy parser reads more still), which this does not reproduce.
pub(crate) fn parse_date(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();

    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
    {
        return None;
    }

    let field = |from: usize, to: usize| -> Option<i64> {
        let digits = &text[from..to];

        digits.bytes().all(|byte| byte.is_ascii_digit()).then(|| digits.parse().ok()).flatten()
    };
    let (year, month, day) = (field(0, 4)?, field(5, 7)?, field(8, 10)?);
    let (hour, minute, second, millisecond) = (field(11, 13)?, field(14, 16)?, field(17, 19)?, field(20, 23)?);
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };

    if day < 1 || day > days_in_month || hour > 23 || minute > 59 || second > 59 {
        return None;
    }

    // Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
    let shifted_year = if month <= 2 { year - 1 } else { year };
    let era = shifted_year.div_euclid(400);
    let year_of_era = shifted_year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;

    Some(((days * 24 + hour) * 60 * 60 * 1000 + minute * 60 * 1000 + second * 1000 + millisecond) as f64)
}

/// `value.toFixed(digits)` for 0 to 2 digits: the decimal that is closest to the double, the larger one on a tie. `None`
/// for a number `toFixed` writes in exponent form (1e21 and above) and for one that is not finite.
pub(super) fn to_fixed(value: f64, digits: u32) -> Option<String> {
    if !value.is_finite() || value.abs() >= 1e21 || digits > 2 {
        return None;
    }

    let negative = value < 0.0;
    let magnitude = value.abs();

    // magnitude = mantissa * 2^exponent, exactly.
    let bits = magnitude.to_bits();
    let raw_exponent = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1u64 << 52) - 1);
    let (mantissa, exponent) =
        if raw_exponent == 0 { (fraction, -1074) } else { (fraction | (1u64 << 52), raw_exponent - 1075) };

    // n = round-half-up(magnitude * 10^digits), with integers: the mantissa times 10^digits fits in 60 bits.
    let scaled = u128::from(mantissa) * 10u128.pow(digits);
    let rounded = if exponent >= 0 {
        scaled << exponent
    } else if -exponent >= 100 {
        0
    } else {
        let shift = -exponent as u32;
        let (quotient, remainder) = (scaled >> shift, scaled & ((1u128 << shift) - 1));

        quotient + u128::from(remainder * 2 >= (1u128 << shift))
    };

    let mut text = rounded.to_string();

    if digits > 0 {
        let width = digits as usize + 1;

        if text.len() < width {
            text = format!("{}{text}", "0".repeat(width - text.len()));
        }

        text.insert(text.len() - digits as usize, '.');
    }

    Some(if negative { format!("-{text}") } else { text })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_registry_form_of_a_date_is_read() {
        assert_eq!(parse_date("1970-01-01T00:00:00.000Z"), Some(0.0));
        assert_eq!(parse_date("2024-02-29T12:34:56.789Z"), Some(1_709_210_096_789.0));
        assert_eq!(parse_date("2000-03-01T00:00:00.001Z"), Some(951_868_800_001.0));
        assert_eq!(parse_date("1969-12-31T23:59:59.999Z"), Some(-1.0));
        assert_eq!(parse_date("0000-01-01T00:00:00.000Z"), Some(-62_167_219_200_000.0));
        assert_eq!(parse_date("9999-12-31T23:59:59.999Z"), Some(253_402_300_799_999.0));
    }

    #[test]
    fn every_other_form_is_left_to_node() {
        for text in [
            "",
            "2024-01-01",
            "2024-01-01T00:00:00Z",
            "2024-01-01T00:00:00.000",
            "2024-01-01 00:00:00.000Z",
            "2024-13-01T00:00:00.000Z",
            "2023-02-29T00:00:00.000Z",
            "2024-04-31T00:00:00.000Z",
            "2024-01-01T24:00:00.000Z",
            "2024-01-01T00:60:00.000Z",
            "2024-01-01T00:00:60.000Z",
            "2024-01-00T00:00:00.000Z",
            "+2024-01-01T00:00:00.000Z",
            "2024-01-01T00:00:00.000+00:00",
            "2024-01-01t00:00:00.000z",
            "created",
            "20x4-01-01T00:00:00.000Z",
            "2024-01-01T00:00:00.00\u{e9}",
        ] {
            assert_eq!(parse_date(text), None, "{text}");
        }
    }

    #[test]
    fn to_fixed_rounds_the_way_javascript_does() {
        for (value, digits, expected) in [
            (0.0, 1, "0.0"),
            (-0.0, 1, "0.0"),
            (1.0, 1, "1.0"),
            (6.96, 1, "7.0"),
            (6.94, 1, "6.9"),
            (0.25, 1, "0.3"),
            (0.35, 1, "0.3"),
            (2.5, 0, "3"),
            (3.5, 0, "4"),
            (0.5, 0, "1"),
            (1.45, 1, "1.4"),
            (1.005, 2, "1.00"),
            (-6.96, 1, "-7.0"),
            (-0.04, 1, "-0.0"),
            (-2.5, 0, "-3"),
            (183.0, 0, "183"),
            (273.6, 0, "274"),
            (123_456.789, 1, "123456.8"),
            (1e20, 0, "100000000000000000000"),
            (5e-324, 1, "0.0"),
            (0.049, 1, "0.0"),
            (0.05, 1, "0.1"),
        ] {
            assert_eq!(to_fixed(value, digits).as_deref(), Some(expected), "{value}.toFixed({digits})");
        }

        assert_eq!(to_fixed(1e21, 1), None);
        assert_eq!(to_fixed(f64::NAN, 1), None);
        assert_eq!(to_fixed(f64::INFINITY, 0), None);
    }
}
