//! `<hooks-dir>/config.json`, parsed the way `parseConfig` / `parseEntry` in
//! `src/commands/hook/config.ts` parse it, including the "wrong type ⇒ silently
//! ignored" coercion of optional fields. A config that the Node parser would
//! reject (or warn about in a way that changes behaviour) yields `None`, which
//! sends the run to Node so it owns the error text.

use serde_json::Value;

/// What a hook does. Exactly one is set per entry.
pub enum Target {
    Builtin(String),
    Command(String),
    Fail(String),
}

pub struct Entry {
    pub always_run: bool,
    pub args: Vec<String>,
    pub exclude: Option<String>,
    pub exclude_types: Vec<String>,
    pub files: Option<String>,
    pub id: String,
    pub name: Option<String>,
    pub pass_filenames: bool,
    pub target: Target,
    pub types: Vec<String>,
    pub types_or: Vec<String>,
    pub verbose: bool,
}

impl Entry {
    pub fn has_tag_filter(&self) -> bool {
        !self.types.is_empty() || !self.types_or.is_empty() || !self.exclude_types.is_empty()
    }
}

pub struct Config {
    pub fail_fast: bool,
    /// Whether the dispatcher `hook install` writes exits 0 under CI (`skipInCI`).
    #[cfg(unix)]
    pub skip_in_ci: bool,
    stages: Vec<(String, Vec<Entry>)>,
}

impl Config {
    /// The hooks of `name` (empty when the stage is not configured).
    pub fn into_stage(self, name: &str) -> Vec<Entry> {
        self.stages.into_iter().find(|(stage, _)| stage == name).map(|(_, entries)| entries).unwrap_or_default()
    }
}

fn as_string_array(value: Option<&Value>) -> Option<Vec<String>> {
    value?.as_array()?.iter().map(|item| item.as_str().map(str::to_owned)).collect()
}

fn as_non_empty_string(value: Option<&Value>) -> Option<String> {
    value?.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

/// `entry[key] !== undefined` after `parseEntry`'s type coercion.
fn key_is_defined(value: Option<&Value>, key: &str) -> bool {
    match key {
        "exclude" | "files" => as_non_empty_string(value).is_some(),
        "passFilenames" => value.and_then(Value::as_bool).is_some(),
        _ => as_string_array(value).is_some(),
    }
}

fn parse_entry(raw: &Value) -> Option<Entry> {
    let object = raw.as_object()?;
    let id = object.get("id")?.as_str().filter(|s| !s.is_empty())?.to_owned();
    let builtin = as_non_empty_string(object.get("builtin"));
    let command = as_non_empty_string(object.get("entry"));
    let fail = as_non_empty_string(object.get("fail"));

    let target = match (builtin, command, fail) {
        (Some(name), None, None) => Target::Builtin(name),
        (None, Some(command), None) => Target::Command(command),
        (None, None, Some(message)) => {
            // `fail` hooks reject filter keys outright; let Node produce that error.
            let filters = ["args", "exclude", "excludeTypes", "files", "passFilenames", "types", "typesOr"];

            if filters.iter().any(|key| key_is_defined(object.get(*key), key)) {
                return None;
            }

            Target::Fail(message)
        }
        _ => return None,
    };

    Some(Entry {
        always_run: object.get("alwaysRun").and_then(Value::as_bool).unwrap_or(false),
        args: as_string_array(object.get("args")).unwrap_or_default(),
        exclude: as_non_empty_string(object.get("exclude")),
        exclude_types: as_string_array(object.get("excludeTypes")).unwrap_or_default(),
        files: as_non_empty_string(object.get("files")),
        id,
        name: as_non_empty_string(object.get("name")),
        pass_filenames: object.get("passFilenames").and_then(Value::as_bool).unwrap_or(true),
        target,
        types: as_string_array(object.get("types")).unwrap_or_default(),
        types_or: as_string_array(object.get("typesOr")).unwrap_or_default(),
        verbose: object.get("verbose").and_then(Value::as_bool).unwrap_or(false),
    })
}

pub fn parse(raw: &Value) -> Option<Config> {
    let object = raw.as_object()?;

    if object.get("version")?.as_f64()? != 1.0 {
        return None;
    }

    let stages = object
        .get("stages")?
        .as_object()?
        .iter()
        .map(|(stage, list)| {
            let entries = list.as_array()?.iter().map(parse_entry).collect::<Option<Vec<_>>>()?;

            Some((stage.clone(), entries))
        })
        .collect::<Option<Vec<_>>>()?;

    Some(Config {
        fail_fast: object.get("failFast").and_then(Value::as_bool).unwrap_or(false),
        #[cfg(unix)]
        skip_in_ci: object.get("skipInCI").and_then(Value::as_bool).unwrap_or(false),
        stages,
    })
}
