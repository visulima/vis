//! Help output for `vis`: the root listing, per-command help and the subcommand
//! listing, laid out exactly as the Node CLI prints them today.
//!
//! Everything is driven by the generated command manifest, so commands that are
//! still served by Node show up here too.

use crate::manifest::{ArgDef, Command, EnvDef, Example, Manifest, OptionDef, Routed};
use crate::table::{render, visible_width, Cell, Layout};
use crate::term::Style;

const CLI_NAME: &str = "vis";

/// Environment variables cerebro documents in the root help (not part of any command).
const ENVIRONMENT: &[(&str, &str)] = &[
    ("CEREBRO_OUTPUT_LEVEL", "Controls the verbosity level of output. Valid values: '16' (quiet), '32' (normal), '64' (verbose), '128' (debug)"),
    ("CEREBRO_MIN_NODE_VERSION", "Sets the minimum required Node.js version. Overrides the default minimum version check"),
    ("NO_UPDATE_NOTIFIER", "When set, disables the update notifier check"),
    ("NODE_ENV", "Standard Node.js environment variable. When set to 'test', disables update notifier"),
    ("DEBUG", "When set, enables debug output (same as --debug flag)"),
    ("CEREBRO_TERMINAL_WIDTH", "Sets the terminal width for table rendering. Useful for testing and consistent output"),
];

/// A name and a description: one line of a command listing.
type Row = (String, String);

impl Style {
    /// A reverse-video label in `color` (`32` green, `33` yellow, ...), bold around it.
    fn label(self, color: u8, text: &str) -> String {
        self.bold(&self.paint(7, 27, &self.paint(color, 39, text)))
    }

    /// Group titles keep a bold leading space outside the reverse-video block.
    fn group_label(self, text: &str) -> String {
        self.bold(&format!(" {}", self.paint(7, 27, &self.paint(32, 39, &format!(" {text} ")))))
    }

    fn style_by_name(self, name: &str, text: &str) -> Option<String> {
        let (open, close) = match name {
            "bold" => (1, 22),
            "dim" => (2, 22),
            "italic" => (3, 23),
            "underline" => (4, 24),
            "inverse" => (7, 27),
            "black" => (30, 39),
            "red" => (31, 39),
            "green" => (32, 39),
            "yellow" => (33, 39),
            "blue" => (34, 39),
            "magenta" => (35, 39),
            "cyan" => (36, 39),
            "white" => (37, 39),
            "gray" | "grey" => (90, 39),
            _ => return None,
        };

        Some(self.paint(open, close, text))
    }

    /// The Node CLI runs every description through a `{style text}` template engine.
    /// Text that is not valid template markup (a stray `}`, an unknown style) is
    /// printed as written, which is what its error fallback does.
    fn template(self, text: &str) -> String {
        if !text.contains(['{', '}', '\\']) {
            return text.to_owned();
        }

        self.parse_template(text).unwrap_or_else(|| text.to_owned())
    }

    fn parse_template(self, text: &str) -> Option<String> {
        if text.contains('\\') {
            return None;
        }

        // Each open `{style text}` is a frame holding its style names and the text so far.
        let mut frames: Vec<(Vec<String>, String)> = vec![(Vec::new(), String::new())];
        let characters: Vec<char> = text.chars().collect();
        let mut index = 0;

        while index < characters.len() {
            let character = characters[index];

            if character == '{' {
                let mut end = index + 1;

                while end < characters.len() && (characters[end].is_ascii_alphabetic() || characters[end] == '.') {
                    end += 1;
                }

                let followed_by_space = characters.get(end).is_some_and(|next| *next == ' ' || *next == '\t');

                if end > index + 1 && followed_by_space {
                    let names =
                        characters[index + 1..end].iter().collect::<String>().split('.').map(str::to_owned).collect();

                    frames.push((names, String::new()));
                    index = end + 1;

                    continue;
                }
            }

            if character == '}' {
                if frames.len() == 1 {
                    return None;
                }

                let (names, body) = frames.pop()?;
                let mut styled = body;

                for name in names.iter().rev() {
                    styled = self.style_by_name(name, &styled)?;
                }

                frames.last_mut()?.1.push_str(&styled);
                index += 1;

                continue;
            }

            frames.last_mut()?.1.push(character);
            index += 1;
        }

        if frames.len() == 1 {
            frames.pop().map(|(_, text)| text)
        } else {
            None
        }
    }
}

/// A help section: an optional header line and a body block.
struct Section {
    header: Option<String>,
    body: String,
}

impl Section {
    fn titled(header: String, body: String) -> Self {
        Self { header: Some(header), body }
    }

    fn raw(body: String) -> Self {
        Self { header: None, body }
    }

    fn text(&self) -> String {
        match &self.header {
            Some(header) => format!("{header}\n\n{}\n", self.body),
            None => format!("{}\n", self.body),
        }
    }
}

pub struct Help<'a> {
    pub manifest: &'a Manifest,
    pub style: Style,
    pub width: usize,
    pub version: &'a str,
}

impl Help<'_> {
    fn banner(&self) -> String {
        format!("{CLI_NAME} v{}\n", self.version)
    }

    fn finish(&self, sections: &[Section]) -> String {
        let body = sections.iter().map(Section::text).collect::<Vec<_>>().join("\n");

        format!("{}\n{body}\n", self.banner())
    }

    fn name(&self) -> String {
        self.style.cyan(CLI_NAME)
    }

    fn text_table(&self, text: &str) -> String {
        let layout = Layout { pad_left: 4, pad_right: 1, width: self.width, fixed: None };

        render(&[vec![Cell::new(self.style.template(text))]], &layout)
    }

    /// Two-column rows (names never wrap). Column widths are fixed when the name
    /// column leaves room for a readable description, as the Node CLI does.
    fn list_table(&self, rows: &[(String, String)]) -> String {
        let widest = rows.iter().map(|(name, _)| visible_width(name)).max().unwrap_or(0);
        let padding = 5;
        let name_width = widest + padding;
        let fixed =
            (widest > 0 && name_width + 20 + padding <= self.width).then(|| vec![name_width, self.width - name_width]);
        let cells: Vec<Vec<Cell>> = rows
            .iter()
            .map(|(name, description)| {
                let name_cell = if fixed.is_some() { Cell::unwrapped(name.clone()) } else { Cell::new(name.clone()) };

                vec![name_cell, Cell::new(self.style.template(description))]
            })
            .collect();

        render(&cells, &Layout { pad_left: 4, pad_right: 1, width: self.width, fixed })
    }

    fn type_text(&self, label: Option<&String>, kind: &str, multiple: bool) -> String {
        match label {
            Some(label) => self.style.template(label),
            None => {
                let kind = if kind.is_empty() { "string" } else { kind };

                self.style.underline(&format!("{kind}{}", if multiple { "[]" } else { "" }))
            }
        }
    }

    fn option_row(&self, option: &OptionDef) -> Vec<Cell> {
        let name = self.style.bold(&self.style.yellow(&format!("--{}", option.name)));
        let kind = self.type_text(option.type_label.as_ref(), &option.kind, option.multiple);
        let names = match &option.alias {
            Some(alias) => format!("{}, {name} {kind}", self.style.bold(&format!("-{alias}"))),
            None => format!("{name} {kind}"),
        };

        vec![Cell::new(names), Cell::new(self.style.template(&option.description))]
    }

    fn argument_row(&self, argument: &ArgDef) -> Vec<Cell> {
        let kind = self.type_text(argument.type_label.as_ref(), &argument.kind, argument.multiple);

        vec![
            Cell::new(format!("{} {kind}", self.style.bold(&argument.name))),
            Cell::new(self.style.template(&argument.description)),
        ]
    }

    fn rows_table(&self, rows: Vec<Vec<Cell>>) -> String {
        render(&rows, &Layout { pad_left: 2, pad_right: 1, width: self.width, fixed: None })
    }

    fn options_section(&self, header: String, options: &[OptionDef]) -> Section {
        Section::titled(
            header,
            self.rows_table(
                options.iter().filter(|option| !option.hidden).map(|option| self.option_row(option)).collect(),
            ),
        )
    }

    fn global_options(&self, lean: bool) -> Section {
        let options = if lean { &self.manifest.lean_global_options } else { &self.manifest.global_options };

        self.options_section(self.style.label(33, " Global Options "), options)
    }

    fn command_row(&self, command: &Command) -> (String, String) {
        let aliases = if command.alias.is_empty() { String::new() } else { format!(" [{}]", command.alias.join(", ")) };

        (format!("{}{aliases}", self.style.green(&command.path_string())), command.description.clone())
    }

    /// `vis`, `vis --help` and `vis help [--group <name>]`.
    pub fn root(&self, group: Option<&str>) -> String {
        let mut groups: Vec<(Option<&str>, Vec<Row>)> = Vec::new();

        for command in self.manifest.commands.iter().filter(|command| !command.hidden) {
            if group.is_some_and(|wanted| command.group.as_deref() != Some(wanted)) {
                continue;
            }

            let key = command.group.as_deref();
            let row = self.command_row(command);

            match groups.iter_mut().find(|(name, _)| *name == key) {
                Some((_, rows)) => rows.push(row),
                None => groups.push((key, vec![row])),
            }
        }

        let usage = format!(
            "{} {} [positional arguments] {}",
            self.name(),
            self.style.green("<command>"),
            self.style.yellow("[options]")
        );
        let mut sections = vec![Section::titled(self.style.label(36, " Usage "), self.text_table(&usage))];

        for (key, rows) in &groups {
            let header = match key {
                Some(name) if group.is_none() => self.style.group_label(&capitalize(name)),
                _ => {
                    let title = group.map(|name| format!(" {}", capitalize(name))).unwrap_or_default();

                    self.style.label(32, &format!(" Available{title} Commands "))
                }
            };

            sections.push(Section::titled(header, self.list_table(rows)));
        }

        sections.push(self.options_section(self.style.label(33, " Command Options "), &self.manifest.help_options));
        sections.push(self.global_options(false));

        let environment: Vec<(String, String)> =
            ENVIRONMENT.iter().map(|(name, description)| ((*name).to_owned(), (*description).to_owned())).collect();

        sections.push(Section::titled(self.style.label(35, " Environment Variables "), self.list_table(&environment)));
        sections.push(Section::raw(format!(
            "Run \"{} {}\" or \"{} {} {}\" for help with a specific command.",
            self.name(),
            self.style.green("help <command>"),
            self.name(),
            self.style.green("<command>"),
            self.style.yellow("--help")
        )));

        self.finish(&sections)
    }

    fn positional_usage(command: &Command) -> String {
        if let Some(argument) = &command.argument {
            return if argument.hidden { String::new() } else { " [positional arguments]".to_owned() };
        }

        command
            .arguments
            .iter()
            .filter(|argument| !argument.hidden)
            .map(|argument| {
                let name = format!("{}{}", argument.name, if argument.multiple { "..." } else { "" });

                if argument.required {
                    format!(" <{name}>")
                } else {
                    format!(" [{name}]")
                }
            })
            .collect()
    }

    /// `vis <command> --help` (`lean` per the command) and `vis help <command>` (never lean:
    /// `help` always runs in the full CLI).
    pub fn command(&self, command: &Command, lean: bool) -> String {
        let path = command.path_string();
        let options_hint = if command.options.is_some() { " [options]" } else { "" };
        let usage =
            format!("{} {}{}{options_hint}", self.name(), self.style.green(&path), Self::positional_usage(command));
        let mut sections = vec![Section::titled(self.style.label(36, " Usage "), self.text_table(&usage))];

        if !command.alias.is_empty() {
            let rows: Vec<Vec<Cell>> = command.alias.iter().map(|alias| vec![Cell::new(alias.clone())]).collect();

            sections.push(Section::titled(
                self.style.bold("Alias(es)"),
                render(&rows, &Layout { pad_left: 4, pad_right: 1, width: self.width, fixed: None }),
            ));
        }

        if !command.description.is_empty() {
            sections
                .push(Section::titled(self.style.label(32, " Description "), self.text_table(&command.description)));
        }

        let positionals: Vec<&ArgDef> =
            command.argument.iter().chain(command.arguments.iter()).filter(|argument| !argument.hidden).collect();

        if !positionals.is_empty() {
            sections.push(Section::titled(
                self.style.bold("Command Positional Arguments"),
                self.rows_table(positionals.into_iter().map(|argument| self.argument_row(argument)).collect()),
            ));
        }

        if let Some(options) = command.options.as_ref().filter(|options| !options.is_empty()) {
            sections.push(self.options_section(self.style.label(33, " Command Options "), options));
        }

        sections.push(self.global_options(lean));

        let environment: Vec<&EnvDef> = command.env.iter().filter(|entry| !entry.hidden).collect();

        if !environment.is_empty() {
            let rows: Vec<(String, String)> =
                environment.iter().map(|entry| (entry.name.clone(), entry.description.clone())).collect();

            sections.push(Section::titled(self.style.label(35, " Environment Variables "), self.list_table(&rows)));
        }

        if !command.examples.is_empty() {
            sections.push(Section::titled(self.style.bold("Examples"), self.examples_table(&command.examples)));
        }

        let path_words = command.path();
        let subcommands = self.manifest.subcommands_of(&path_words);

        if !subcommands.is_empty() {
            let rows: Vec<(String, String)> =
                subcommands.iter().map(|sub| (self.style.green(&sub.path_string()), sub.description.clone())).collect();

            sections.push(Section::titled(self.style.label(32, " Subcommands "), self.list_table(&rows)));
        }

        self.finish(&sections)
    }

    fn examples_table(&self, examples: &[Example]) -> String {
        if examples.iter().all(|example| matches!(example, Example::Row(row) if row.len() == 2)) {
            let rows: Vec<(String, String)> = examples
                .iter()
                .filter_map(|example| match example {
                    Example::Row(row) => Some((row[0].clone(), row[1].clone())),
                    Example::Line(_) => None,
                })
                .collect();

            return self.list_table(&rows);
        }

        let rows = examples
            .iter()
            .map(|example| match example {
                Example::Line(line) => vec![Cell::new(self.style.template(line))],
                Example::Row(row) => row.iter().map(|text| Cell::new(self.style.template(text))).collect(),
            })
            .collect::<Vec<_>>();

        render(&rows, &Layout { pad_left: 4, pad_right: 1, width: self.width, fixed: None })
    }

    /// Listing for a path that is only a parent of other commands (`vis help cache`).
    pub fn subcommands(&self, prefix: &[&str], subcommands: &[&Command]) -> String {
        let path = prefix.join(" ");
        let usage = format!(
            "{} {} {} [positional arguments] {}",
            self.name(),
            self.style.green(&path),
            self.style.green("<subcommand>"),
            self.style.yellow("[options]")
        );
        let rows: Vec<(String, String)> =
            subcommands.iter().map(|sub| (self.style.green(&sub.path_string()), sub.description.clone())).collect();
        let sections = vec![
            Section::titled(self.style.label(36, " Usage "), self.text_table(&usage)),
            Section::titled(self.style.label(32, " Subcommands "), self.list_table(&rows)),
            self.global_options(false),
            Section::raw(format!(
                "Run \"{} {} {}\" for help with a specific subcommand.",
                self.name(),
                self.style.green(&format!("{path} <subcommand>")),
                self.style.yellow("--help")
            )),
        ];

        self.finish(&sections)
    }
}

fn capitalize(text: &str) -> String {
    let mut characters = text.chars();

    match characters.next() {
        Some(first) => first.to_uppercase().chain(characters).collect(),
        None => String::new(),
    }
}
