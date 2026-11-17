//! The command manifest: every `vis` command, as generated from the TypeScript
//! command definitions by `scripts/generate-command-manifest.ts`.
//!
//! The JSON is embedded at build time and parsed on demand, so the help, unknown
//! command and completion paths never touch Node.

use serde::Deserialize;

const MANIFEST_JSON: &str = include_str!("manifest.json");

#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub commands: Vec<Command>,
    #[serde(rename = "globalOptions")]
    pub global_options: Vec<OptionDef>,
    #[serde(rename = "helpOptions")]
    pub help_options: Vec<OptionDef>,
    /// Global options shown by commands that run through the lean entry (`dlx`, `exec`).
    #[serde(rename = "leanGlobalOptions")]
    pub lean_global_options: Vec<OptionDef>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct Command {
    pub name: String,
    #[serde(rename = "commandPath")]
    pub command_path: Vec<String>,
    pub alias: Vec<String>,
    /// Every key the command is filed under (leaf name, aliases, or its full path).
    pub keys: Vec<String>,
    pub description: String,
    pub group: Option<String>,
    pub hidden: bool,
    /// Served by the lean entry, whose `--help` lists fewer global options.
    pub lean: bool,
    /// `None` when the definition declares no options at all; `Some(vec![])` still prints `[options]`.
    pub options: Option<Vec<OptionDef>>,
    pub argument: Option<ArgDef>,
    pub arguments: Vec<ArgDef>,
    pub env: Vec<EnvDef>,
    pub examples: Vec<Example>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct OptionDef {
    pub name: String,
    pub alias: Option<String>,
    pub description: String,
    pub hidden: bool,
    pub multiple: bool,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "typeLabel")]
    pub type_label: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ArgDef {
    pub name: String,
    pub description: String,
    pub hidden: bool,
    pub multiple: bool,
    pub required: bool,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(rename = "typeLabel")]
    pub type_label: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct EnvDef {
    pub name: String,
    pub description: String,
    pub hidden: bool,
}

/// One entry of a command's `examples`: a bare line or a `[command, description]` row.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum Example {
    Line(String),
    Row(Vec<String>),
}

/// What routing a word to a command needs, so the cheap [`Routes`] and the full [`Command`]
/// resolve identically.
pub trait Routed {
    fn name(&self) -> &str;
    fn command_path(&self) -> &[String];
    fn alias(&self) -> &[String];
    fn keys(&self) -> &[String];
    fn hidden(&self) -> bool;

    /// Full path words: the parent path followed by the name (`["cache", "list"]`).
    fn path(&self) -> Vec<&str> {
        self.command_path().iter().map(String::as_str).chain(std::iter::once(self.name())).collect()
    }

    fn path_string(&self) -> String {
        self.path().join(" ")
    }
}

macro_rules! impl_routed {
    ($type:ty) => {
        impl Routed for $type {
            fn name(&self) -> &str {
                &self.name
            }

            fn command_path(&self) -> &[String] {
                &self.command_path
            }

            fn alias(&self) -> &[String] {
                &self.alias
            }

            fn keys(&self) -> &[String] {
                &self.keys
            }

            fn hidden(&self) -> bool {
                self.hidden
            }
        }
    };
}

impl_routed!(Command);
impl_routed!(Route);

/// A command reduced to what routing needs. Deserializing these skips the options,
/// arguments and examples that make up most of the manifest.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct Route {
    name: String,
    #[serde(rename = "commandPath")]
    command_path: Vec<String>,
    alias: Vec<String>,
    keys: Vec<String>,
    hidden: bool,
}

/// The manifest as far as routing goes, for invocations that only need to know whether
/// a word is a command.
#[derive(Debug, Deserialize)]
pub struct Routes {
    pub commands: Vec<Route>,
}

impl Routes {
    pub fn load() -> Self {
        serde_json::from_str(MANIFEST_JSON).expect("embedded command manifest is valid JSON")
    }
}

/// Resolve a command the way the Node CLI does: the longest full path among the
/// leading words, else the first word as a key (name or alias).
pub fn resolve<'c, C: Routed>(commands: &'c [C], words: &[&str]) -> Option<&'c C> {
    (1..=words.len()).rev().find_map(|length| {
        let candidate = words[..length].join(" ");

        commands.iter().find(|command| command.path_string() == candidate).or_else(|| {
            if length == 1 {
                by_key(commands, &candidate)
            } else {
                None
            }
        })
    })
}

/// `commands.get(key)` as cerebro's lookup map answers it.
pub fn by_key<'c, C: Routed>(commands: &'c [C], key: &str) -> Option<&'c C> {
    commands.iter().find(|command| command.keys().iter().any(|candidate| candidate == key))
}

/// Visible commands whose path starts with `prefix` and is longer than it.
pub fn subcommands_of<'c, C: Routed>(commands: &'c [C], prefix: &[&str]) -> Vec<&'c C> {
    commands
        .iter()
        .filter(|command| {
            !command.hidden()
                && command.command_path().len() >= prefix.len()
                && command.command_path().iter().zip(prefix).all(|(left, right)| left == right)
        })
        .collect()
}

impl Manifest {
    pub fn load() -> Self {
        serde_json::from_str(MANIFEST_JSON).expect("embedded command manifest is valid JSON")
    }

    /// `commands.get(key)` as cerebro's lookup map answers it.
    pub fn by_key(&self, key: &str) -> Option<&Command> {
        by_key(&self.commands, key)
    }

    /// The command `vis help <words…>` resolves: an exact key, else a command whose
    /// last path word or whole path equals the words.
    pub fn find_for_help(&self, words: &str) -> Option<&Command> {
        self.by_key(words)
            .or_else(|| self.commands.iter().find(|command| command.name == words || command.path_string() == words))
    }

    /// Visible commands whose path starts with `prefix` and is longer than it.
    pub fn subcommands_of(&self, prefix: &[&str]) -> Vec<&Command> {
        subcommands_of(&self.commands, prefix)
    }
}
