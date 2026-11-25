//! What `vis run` prints for a run whose tasks all hit: the static renderer's lines, in the colour and the log grouping
//! of the environment, and the checks that every line fits the 80 columns Node renders them in.

use std::env;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::js::is_js_whitespace;

use super::{Answer, MAX_TASKS};

/// Tasks in flight at once under the default `--parallel`; only the order of the printed lines uses it.
const DEFAULT_PARALLEL: usize = 3;

/// The longest title the static header renders on one line (the rest wraps in Node).
const MAX_TITLE_WIDTH: usize = 60;

/// Rendered width the task lines must stay under: `✓  <id> [cache] (<n> ms)`.
const MAX_ID_WIDTH: usize = 50;

/// The separator under and over the output of a task: 80 columns, the width Node uses off a terminal.
const SEPARATOR_WIDTH: usize = 80;

/// How Node's static renderer groups the output of a task in the log: the first of these that applies
/// (`resolveCiGroupingMode`, which compares the value exactly, `TF_BUILD` ignoring case).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Grouping {
    /// Separator lines above and below the output.
    Separators,
    Github,
    Gitlab,
    Buildkite,
    Azure,
}

impl Grouping {
    pub(super) fn detect() -> Self {
        let is = |name: &str, expected: &str| env::var_os(name).is_some_and(|value| value == expected);

        if is("GITHUB_ACTIONS", "true") {
            Self::Github
        } else if is("GITLAB_CI", "true") {
            Self::Gitlab
        } else if is("BUILDKITE", "true") {
            Self::Buildkite
        } else if env::var_os("TF_BUILD").is_some_and(|value| value.eq_ignore_ascii_case("true")) {
            Self::Azure
        } else {
            Self::Separators
        }
    }
}

/// What the static renderer prints around the plain text: the colour codes and the grouping directives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Look {
    pub(super) colour: bool,
    pub(super) grouping: Grouping,
}

/// `(durationMs / 1000).toFixed(1)` for a duration below one second: JavaScript rounds an exact tie up,
/// Rust rounds it to even.
fn seconds_text(milliseconds: u64) -> String {
    if milliseconds % 500 == 250 {
        return format!("{:.1}", (milliseconds + 50) as f64 / 1000.0);
    }

    format!("{:.1}", milliseconds as f64 / 1000.0)
}

/// `formatMs` for a duration below one second.
fn duration_text(milliseconds: u64) -> String {
    format!("{milliseconds} ms")
}

impl Look {
    /// `plain` as it is, or `coloured` when the renderer prints colour codes.
    fn paint(&self, plain: &str, coloured: &str) -> String {
        if self.colour { coloured } else { plain }.to_owned()
    }

    /// ` VIS  \u{2022}` with the bullet in `bullet` (37 white, 32 green).
    fn banner(&self, bullet: &str) -> String {
        self.paint(
            " VIS  \u{2022}",
            &format!(
                "\u{1b}[1m\u{1b}[7m VIS \u{1b}[22m\u{1b}[27m \u{1b}[1m\u{1b}[{bullet}m\u{2022}\u{1b}[22m\u{1b}[39m"
            ),
        )
    }

    /// The success tick, green off a plain log.
    fn tick(&self) -> String {
        self.paint("\u{2713}", "\u{1b}[32m\u{2713}\u{1b}[39m")
    }

    /// The stored output of a task, set off from the rest of the log the way the environment's grouping does it
    /// (`logCommandOutputCI`, for a task that succeeded).
    fn output_block(&self, id: &str, trimmed: &str, out: &mut String) {
        let tick = self.tick();

        match self.grouping {
            Grouping::Separators => {
                let dashes = "\u{2014}".repeat(SEPARATOR_WIDTH);
                let separator = self.paint(&dashes, &format!("\u{1b}[2m{dashes}\u{1b}[22m"));
                let label = self.paint(
                    &format!("\u{2713} [cache] {id}"),
                    &format!("{tick} \u{1b}[36m[cache]\u{1b}[39m \u{1b}[1m{id}\u{1b}[22m"),
                );

                out.push_str(&format!("{separator}\n{label}\n{trimmed}\n{separator}\n"));
            }
            Grouping::Github => out.push_str(&format!("::group::{tick} {id}\n{trimmed}\n::endgroup::\n")),
            Grouping::Gitlab => {
                let key = gitlab_section_key(id);
                let erase = "\u{1b}[0K";

                out.push_str(&format!(
                    "{erase}section_start:{}:{key}[collapsed=true]\r{erase}{tick} {id}\n{trimmed}\n",
                    unix_seconds()
                ));
                out.push_str(&format!("{erase}section_end:{}:{key}\r{erase}\n", unix_seconds()));
            }
            Grouping::Buildkite => out.push_str(&format!("--- {tick} {id}\n{trimmed}\n")),
            Grouping::Azure => out.push_str(&format!("##[group]{tick} {id}\n{trimmed}\n##[endgroup]\n")),
        }
    }
}

/// `Math.floor(Date.now() / 1000)`.
fn unix_seconds() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_secs())
}

/// `toGitLabSectionKey`: the task id with every run of non-word characters turned into one `_`, then `_`
/// and the first six hex digits of the SHA-256 of the id. (Task ids are printable ASCII here.)
fn gitlab_section_key(id: &str) -> String {
    use sha2::{Digest, Sha256};

    let mut slug = String::new();
    let mut in_run = false;

    for c in id.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            slug.push(c);
            in_run = false;
        } else if !in_run {
            slug.push('_');
            in_run = true;
        }
    }

    let digest = Sha256::digest(id.as_bytes());

    format!("{slug}_{:02x}{:02x}{:02x}", digest[0], digest[1], digest[2])
}

/// `target <target> for project <name>` for one task, `... for <count> projects` for more.
fn describe(target: &str, count: usize, first_id: &str) -> String {
    if count == 1 {
        return format!("target {target} for project {}", first_id.trim_end_matches(&format!(":{target}")));
    }

    format!("target {target} for {count} projects")
}

/// Whether the lines of a run of `ids` fit what the renderer prints on one line, and the count stays below the one
/// where Node's layout changes. Every line this module prints has to fit the 80 columns Node renders them in.
pub(super) fn layout_fits(target: &str, ids: &[&str]) -> bool {
    ids.len() < MAX_TASKS
        && ids.iter().all(|id| id.len() <= MAX_ID_WIDTH)
        && ids.first().is_some_and(|first| {
            format!("Successfully ran {}", describe(target, ids.len(), first)).len() <= MAX_TITLE_WIDTH
        })
}

impl Answer {
    fn description(&self) -> String {
        describe(&self.target, self.hits.len(), &self.hits[0].key.id)
    }

    /// Whether the times fit what the renderer prints (`formatMs` below one second).
    pub(super) fn fits(&self) -> bool {
        self.milliseconds < 1000 && self.hits.iter().all(|hit| hit.milliseconds < 1000)
    }

    /// What the static renderer prints for a run whose tasks all hit, off a terminal, in the colour and
    /// grouping of the environment.
    pub(super) fn stdout(&self) -> String {
        let look = self.look;
        let mut out = String::new();
        let description = self.description();

        out.push_str(&format!(
            "{}  Running {description}\n  With additional flags:\n    --visOptions={{}}\n\n",
            look.banner("37")
        ));

        let finish = |index: usize, out: &mut String| {
            let hit = &self.hits[index];

            out.push_str(&format!(
                "{}  {}{}\n",
                look.tick(),
                hit.key.id,
                look.paint(
                    &format!(" [cache] ({})", duration_text(hit.milliseconds)),
                    &format!("\u{1b}[36m [cache]\u{1b}[2m\u{1b}[39m ({})\u{1b}[22m", duration_text(hit.milliseconds))
                )
            ));

            let trimmed = hit.terminal_output.trim_matches(is_js_whitespace);

            if !trimmed.is_empty() {
                look.output_block(&hit.key.id, trimmed, out);
            }
        };

        // Three tasks start, then each one that ends is followed by the start of the next.
        let start =
            |id: &str, out: &mut String| out.push_str(&format!("{} {id}\n", look.paint(">", "\u{1b}[2m>\u{1b}[22m")));

        for hit in self.hits.iter().take(DEFAULT_PARALLEL) {
            start(&hit.key.id, &mut out);
        }

        for index in 0..self.hits.len() {
            finish(index, &mut out);

            if let Some(next) = self.hits.get(index + DEFAULT_PARALLEL) {
                start(&next.key.id, &mut out);
            }
        }

        let count = self.hits.len();

        out.push_str(&format!(
            "\n{}  Successfully ran {description}\n\n   {}  {count} tasks completed{}\n\n",
            look.banner("32"),
            look.tick(),
            look.paint(
                &format!(" ({count} read from cache)  \u{b7}  Took {}", duration_text(self.milliseconds)),
                &format!(
                    "\u{1b}[2m ({count} read from cache)  \u{b7}  Took {}\u{1b}[22m",
                    duration_text(self.milliseconds)
                )
            )
        ));
        out.push_str(&format!("  {count} cached \u{b7} {}s\n", seconds_text(self.milliseconds)));

        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seconds_round_like_to_fixed() {
        assert_eq!(seconds_text(0), "0.0");
        assert_eq!(seconds_text(32), "0.0");
        assert_eq!(seconds_text(150), "0.1");
        assert_eq!(seconds_text(250), "0.3");
        assert_eq!(seconds_text(750), "0.8");
        assert_eq!(seconds_text(999), "1.0");
    }

    #[test]
    fn gitlab_section_keys_match_the_node_slug_and_hash() {
        assert_eq!(gitlab_section_key("p2:build"), "p2_build_a9450b");
        assert_eq!(gitlab_section_key("@acme/p2:build"), "_acme_p2_build_e36233");
        assert_eq!(gitlab_section_key("a--b:x.y"), "a_b_x_y_200432");
    }

    #[test]
    fn the_look_wraps_the_codes_only_with_colour() {
        let plain = Look { colour: false, grouping: Grouping::Github };
        let colour = Look { colour: true, grouping: Grouping::Azure };
        let mut out = String::new();

        plain.output_block("p:build", "out", &mut out);
        colour.output_block("p:build", "out", &mut out);

        assert_eq!(out, "::group::\u{2713} p:build\nout\n::endgroup::\n##[group]\u{1b}[32m\u{2713}\u{1b}[39m p:build\nout\n##[endgroup]\n");
        assert_eq!(plain.banner("37"), " VIS  \u{2022}");
        assert!(colour.banner("32").starts_with("\u{1b}[1m\u{1b}[7m VIS "));
    }

    #[test]
    fn the_layout_is_checked_before_any_file_is_read() {
        let ids = |count: usize| (0..count).map(|index| format!("p{index}:build")).collect::<Vec<_>>();
        let fits =
            |target: &str, ids: &[String]| layout_fits(target, &ids.iter().map(String::as_str).collect::<Vec<_>>());

        assert!(fits("build", &ids(1)));
        assert!(fits("build", &ids(999)));
        assert!(!fits("build", &ids(1000)));
        assert!(!fits("build", &[]));
        assert!(fits("build", &["p:build".to_owned(), format!("{}:build", "a".repeat(44))]));
        assert!(!fits("build", &["p:build".to_owned(), format!("{}:build", "a".repeat(45))]));
        // The title `Successfully ran target <target> for <n> projects` has to stay on one line.
        assert!(fits(&"t".repeat(20), &ids(10)));
        assert!(!fits(&"t".repeat(40), &ids(10)));
        assert_eq!(describe("build", 1, "p3:build"), "target build for project p3");
        assert_eq!(describe("build", 12, "p3:build"), "target build for 12 projects");
    }
}
