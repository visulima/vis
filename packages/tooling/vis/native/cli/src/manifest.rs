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

impl Command {
    /// Full path words: the parent path followed by the name (`["cache", "list"]`).
    pub fn path(&self) -> Vec<&str> {
        self.command_path.iter().map(String::as_str).chain(std::iter::once(self.name.as_str())).collect()
    }

    pub fn path_string(&self) -> String {
        self.path().join(" ")
    }
}

impl Manifest {
    pub fn load() -> Self {
        serde_json::from_str(MANIFEST_JSON).expect("embedded command manifest is valid JSON")
    }

    /// `commands.get(key)` as cerebro's lookup map answers it.
    pub fn by_key(&self, key: &str) -> Option<&Command> {
        self.commands.iter().find(|command| command.keys.iter().any(|candidate| candidate == key))
    }

    /// The command `vis help <words…>` resolves: an exact key, else a command whose
    /// last path word or whole path equals the words.
    pub fn find_for_help(&self, words: &str) -> Option<&Command> {
        self.by_key(words)
            .or_else(|| self.commands.iter().find(|command| command.name == words || command.path_string() == words))
    }

    /// Visible commands whose path starts with `prefix` and is longer than it.
    pub fn subcommands_of(&self, prefix: &[&str]) -> Vec<&Command> {
        self.commands
            .iter()
            .filter(|command| {
                !command.hidden
                    && command.command_path.len() >= prefix.len()
                    && command.command_path.iter().zip(prefix).all(|(left, right)| left == right)
            })
            .collect()
    }
}
