//! The text forms of sizes, dates and ages that Node prints.

use vis_core::date::iso_from_millis;

/// Sizes from which the humanizer's `Math.log` ratio can sit on the wrong side of a power of 1024
/// (`2**50 - 1` already prints as petabytes). The integer unit below is exact; Node's is not.
const FORMAT_BYTES_LIMIT: u64 = 1 << 45;

/// `formatBytes(n, { decimals: 1, space: false })` of `@visulima/humanizer`: metric names over 1024
/// steps, one fixed decimal rounded half away from zero, en-US grouping. `None` for sizes the
/// floating-point unit choice of Node could disagree on.
pub(crate) fn format_bytes(bytes: u64) -> Option<String> {
    const UNITS: [&str; 5] = ["Bytes", "KB", "MB", "GB", "TB"];

    if bytes == 0 {
        return Some("0Bytes".to_owned());
    }

    if bytes >= FORMAT_BYTES_LIMIT {
        return None;
    }

    // `Math.floor(Math.log(n) / Math.log(1024))`, which is the integer logarithm below this limit.
    let step = (bytes.ilog2() / 10) as usize;
    let divisor = 1u64 << (10 * step);

    // Tenths, rounded half up on the exact quotient.
    let scaled = u128::from(bytes) * 10;
    let mut tenths = scaled / u128::from(divisor);

    if (scaled % u128::from(divisor)) * 2 >= u128::from(divisor) {
        tenths += 1;
    }

    let whole = (tenths / 10).to_string();
    let mut grouped = String::new();

    for (index, digit) in whole.chars().enumerate() {
        if index > 0 && (whole.len() - index) % 3 == 0 {
            grouped.push(',');
        }

        grouped.push(digit);
    }

    Some(format!("{grouped}.{}{}", tenths % 10, UNITS[step]))
}

/// `new Date(ms).toISOString()`, `None` outside the years Node prints without an extended form.
pub(crate) fn iso(ms: f64) -> Option<String> {
    let ms = ms.trunc();

    (0.0..=253_402_300_799_999.0).contains(&ms).then(|| iso_from_millis(ms as i64))
}

/// `formatAge`.
pub(crate) fn format_age(mtime_ms: f64, now: f64) -> String {
    let seconds = ((now - mtime_ms) / 1000.0).floor().max(0.0);

    if seconds < 60.0 {
        format!("{seconds}s")
    } else if seconds < 3600.0 {
        format!("{}m", (seconds / 60.0).floor())
    } else if seconds < 86_400.0 {
        format!("{}h", (seconds / 3600.0).floor())
    } else {
        format!("{}d", (seconds / 86_400.0).floor())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_follow_the_humanizer() {
        for (bytes, text) in [
            (0, "0Bytes"),
            (1, "1.0Bytes"),
            (512, "512.0Bytes"),
            (1023, "1,023.0Bytes"),
            (1024, "1.0KB"),
            (1025, "1.0KB"),
            (1280, "1.3KB"),
            (1536, "1.5KB"),
            (4500, "4.4KB"),
            (1_048_575, "1,024.0KB"),
            (1_048_576, "1.0MB"),
            (1_234_567, "1.2MB"),
            (5_000_000_000, "4.7GB"),
            (1_073_741_823, "1,024.0MB"),
            (1_099_511_627_776, "1.0TB"),
        ] {
            assert_eq!(format_bytes(bytes).as_deref(), Some(text), "{bytes}");
        }
    }

    #[test]
    fn huge_sizes_are_left_to_node() {
        assert_eq!(format_bytes(FORMAT_BYTES_LIMIT), None);
        assert!(format_bytes(FORMAT_BYTES_LIMIT - 1).is_some());
    }

    #[test]
    fn dates_are_iso() {
        assert_eq!(iso(0.0).as_deref(), Some("1970-01-01T00:00:00.000Z"));
        assert_eq!(iso(1_763_593_200_123.9).as_deref(), Some("2025-11-19T23:00:00.123Z"));
        assert_eq!(iso(951_782_400_000.0).as_deref(), Some("2000-02-29T00:00:00.000Z"));
        assert_eq!(iso(-1.0), None);
    }

    #[test]
    fn ages_clamp_and_step() {
        assert_eq!(format_age(10_000.0, 0.0), "0s");
        assert_eq!(format_age(0.0, 59_999.0), "59s");
        assert_eq!(format_age(0.0, 60_000.0), "1m");
        assert_eq!(format_age(0.0, 7_200_000.0), "2h");
        assert_eq!(format_age(0.0, 259_200_000.0), "3d");
    }
}
