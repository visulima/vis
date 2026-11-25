//! The run summary the task runner records (`<root>/.vis/last-summary.json`, or `<root>/.vis/runs/<id>.json`): the
//! fields `cache hash` and `cache why` print, read strictly. A key of the wrong type, a duplicate, an unknown key of a
//! hash record or a key JavaScript would reorder is Node's, because serde and `JSON.parse` disagree there and an
//! `undefined` prints differently. Reading the file, finding a task and the failure outputs are in [`crate::summary`].

use std::fmt;
use std::path::{Path, PathBuf};

use serde::de::{self, IgnoredAny, MapAccess, Visitor};
use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::value::RawValue;

use crate::summary::Ordered;

enum Field {
    Text(String),
    Number(u32),
    Bucket(Ordered<String>),
    Lists(Ordered<Vec<String>>),
    Strings(Vec<String>),
}

#[derive(Clone, Copy)]
enum Kind {
    Text,
    Number,
    Bucket,
    Lists,
    Strings,
}

/// The keys an object may hold, and the ones it must. A key outside the schema is Node's.
struct Schema {
    fields: &'static [(&'static str, Kind)],
    required: &'static [&'static str],
}

/// `TaskHashDetails`: what a declared-mode task recorded.
const DETAILS: Schema = Schema {
    fields: &[
        ("command", Kind::Text),
        ("implicitDeps", Kind::Bucket),
        ("layout", Kind::Number),
        ("nodes", Kind::Bucket),
        ("runtime", Kind::Bucket),
    ],
    // The table prints the command, and `undefined.slice` throws in Node.
    required: &["command"],
};

/// `TaskFingerprint`: what a trace-mode task tracked, stored in its cache entry.
const FINGERPRINT: Schema = Schema {
    fields: &[
        ("chainKey", Kind::Text),
        ("commandHash", Kind::Text),
        ("directoryListings", Kind::Lists),
        ("envHashes", Kind::Bucket),
        ("fileHashes", Kind::Bucket),
        ("missingFiles", Kind::Strings),
        ("modifiedInputs", Kind::Strings),
        ("tracker", Kind::Text),
    ],
    // `missingFiles` is mapped over, and the other buckets are printed; Node throws or prints
    // differently when one is absent.
    required: &["commandHash", "directoryListings", "envHashes", "fileHashes", "missingFiles"],
};

/// A JSON object that keeps the order its keys have in the file, because the JSON output prints
/// them in that order.
pub(crate) struct Record(Vec<(&'static str, Field)>);

impl Record {
    pub(crate) fn text(&self, name: &str) -> &str {
        self.0
            .iter()
            .find_map(|(key, field)| match field {
                Field::Text(text) if *key == name => Some(text.as_str()),
                _ => None,
            })
            .unwrap_or_default()
    }

    pub(crate) fn bucket(&self, name: &str) -> &[(String, String)] {
        self.0
            .iter()
            .find_map(|(key, field)| match field {
                Field::Bucket(bucket) if *key == name => Some(bucket.0.as_slice()),
                _ => None,
            })
            .unwrap_or_default()
    }

    pub(crate) fn strings(&self, name: &str) -> &[String] {
        self.0
            .iter()
            .find_map(|(key, field)| match field {
                Field::Strings(list) if *key == name => Some(list.as_slice()),
                _ => None,
            })
            .unwrap_or_default()
    }

    pub(crate) fn number(&self, name: &str) -> Option<u32> {
        self.0.iter().find_map(|(key, field)| match field {
            Field::Number(number) if *key == name => Some(*number),
            _ => None,
        })
    }

    fn read<'de, A: MapAccess<'de>>(schema: &Schema, mut map: A) -> Result<Record, A::Error> {
        let mut fields: Vec<(&'static str, Field)> = Vec::new();

        while let Some(key) = map.next_key::<String>()? {
            let Some(&(name, kind)) = schema.fields.iter().find(|(name, _)| *name == key) else {
                return Err(de::Error::custom("key left to Node"));
            };

            if fields.iter().any(|(seen, _)| *seen == name) {
                return Err(de::Error::custom("duplicate key"));
            }

            let field = match kind {
                Kind::Text => Field::Text(map.next_value()?),
                Kind::Number => Field::Number(map.next_value()?),
                Kind::Bucket => Field::Bucket(map.next_value()?),
                Kind::Lists => Field::Lists(map.next_value()?),
                Kind::Strings => Field::Strings(map.next_value()?),
            };

            fields.push((name, field));
        }

        if schema.required.iter().any(|name| !fields.iter().any(|(seen, _)| seen == name)) {
            return Err(de::Error::custom("required key missing"));
        }

        Ok(Record(fields))
    }
}

impl Serialize for Record {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;

        for (name, field) in &self.0 {
            match field {
                Field::Text(text) => map.serialize_entry(name, text)?,
                Field::Number(number) => map.serialize_entry(name, number)?,
                Field::Bucket(bucket) => map.serialize_entry(name, bucket)?,
                Field::Lists(lists) => map.serialize_entry(name, lists)?,
                Field::Strings(strings) => map.serialize_entry(name, strings)?,
            }
        }

        map.end()
    }
}

/// A [`Record`] read against one of the schemas above.
macro_rules! record_type {
    ($name:ident, $schema:expr) => {
        pub(crate) struct $name(pub(crate) Record);

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                struct RecordVisitor;

                impl<'de> Visitor<'de> for RecordVisitor {
                    type Value = $name;

                    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                        formatter.write_str(stringify!($name))
                    }

                    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<$name, A::Error> {
                        Record::read(&$schema, map).map($name)
                    }
                }

                deserializer.deserialize_map(RecordVisitor)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                self.0.serialize(serializer)
            }
        }
    };
}

record_type!(Details, DETAILS);
record_type!(Fingerprint, FINGERPRINT);

/// The fields of a `TaskSummary` this command prints. A key of the wrong type, or a duplicate,
/// is Node's: serde and `JSON.parse` disagree there, and an `undefined` prints differently.
pub(crate) struct Task {
    pub(crate) task_id: String,
    pub(crate) cache_status: String,
    pub(crate) hash: Option<String>,
    pub(crate) details: Option<Details>,
    pub(crate) hash_source: Option<String>,
}

impl<'de> Deserialize<'de> for Task {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct TaskVisitor;

        impl<'de> Visitor<'de> for TaskVisitor {
            type Value = Task;

            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a task summary")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Task, A::Error> {
                let (mut task_id, mut cache_status, mut hash, mut details, mut hash_source) =
                    (None, None, None, None, None);

                fn once<T, E: de::Error>(slot: &mut Option<T>, value: T) -> Result<(), E> {
                    if slot.replace(value).is_some() {
                        return Err(E::custom("duplicate task key"));
                    }

                    Ok(())
                }

                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "taskId" => once(&mut task_id, map.next_value::<String>()?)?,
                        "cacheStatus" => once(&mut cache_status, map.next_value::<String>()?)?,
                        "hash" => once(&mut hash, map.next_value::<String>()?)?,
                        "hashDetails" => once(&mut details, map.next_value::<Details>()?)?,
                        "hashSource" => once(&mut hash_source, map.next_value::<String>()?)?,
                        _ => {
                            map.next_value::<IgnoredAny>()?;
                        }
                    }
                }

                Ok(Task {
                    task_id: task_id.ok_or_else(|| de::Error::missing_field("taskId"))?,
                    cache_status: cache_status.ok_or_else(|| de::Error::missing_field("cacheStatus"))?,
                    hash,
                    details,
                    hash_source,
                })
            }
        }

        deserializer.deserialize_map(TaskVisitor)
    }
}

/// The run summary. The tasks stay raw: only the one asked for is read strictly, so another task's
/// unusual entry cannot send a lookup that does not involve it to Node.
#[derive(Deserialize)]
pub(crate) struct Summary {
    pub(crate) id: String,
    pub(crate) tasks: Vec<Box<RawValue>>,
}

/// The `taskId` of a task entry, when it is a string. Node compares with `===`, so a task without
/// one, or with another type, is simply not the task asked for.
#[derive(Deserialize)]
pub(crate) struct Probe {
    #[serde(default, rename = "taskId")]
    pub(crate) task_id: Option<ProbeId>,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(crate) enum ProbeId {
    Text(String),
    Other(IgnoredAny),
}

/// The summary file the request names.
pub(crate) fn summary_path(root: &Path, run: Option<&str>) -> PathBuf {
    match run {
        None => root.join(".vis").join("last-summary.json"),
        Some(id) => root.join(".vis").join("runs").join(format!("{id}.json")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::summary::{find_task, json_text};

    #[test]
    fn a_bucket_declines_the_keys_javascript_reorders_but_keeps_the_empty_key() {
        let parses = |json: &str| serde_json::from_str::<Ordered<String>>(json).is_ok();

        assert!(parses(r#"{"b":"1","a":"2","":"3","007":"4"}"#));

        for key in ["7", "0", "__proto__"] {
            assert!(!parses(&format!(r#"{{"{key}":"x"}}"#)), "{key:?}");
        }

        assert!(!parses(r#"{"a":"1","a":"2"}"#));
    }

    #[test]
    fn details_keep_the_file_order_and_refuse_unknown_keys() {
        let details: Details = serde_json::from_str(r#"{"nodes":{"b":"1","a":"2"},"command":"c","layout":2}"#).unwrap();

        assert_eq!(
            json_text(&details).unwrap(),
            "{\n  \"nodes\": {\n    \"b\": \"1\",\n    \"a\": \"2\"\n  },\n  \"command\": \"c\",\n  \"layout\": 2\n}\n"
        );
        assert!(serde_json::from_str::<Details>(r#"{"command":"c","extra":{}}"#).is_err());
        assert!(serde_json::from_str::<Details>(r#"{"nodes":{}}"#).is_err());
        assert!(serde_json::from_str::<Details>(r#"{"command":"c","nodes":{"1":"x"}}"#).is_err());
        assert!(serde_json::from_str::<Details>(r#"{"command":"c","nodes":{"a":"x","a":"y"}}"#).is_err());
    }

    #[test]
    fn a_task_with_a_mistyped_field_is_left_to_node() {
        assert!(serde_json::from_str::<Task>(r#"{"taskId":"a:b","cacheStatus":"HIT","hash":null}"#).is_err());
        assert!(serde_json::from_str::<Task>(r#"{"taskId":"a:b","cacheStatus":1}"#).is_err());
        assert!(serde_json::from_str::<Task>(r#"{"taskId":"a:b"}"#).is_err());
        assert!(serde_json::from_str::<Task>(r#"{"taskId":"a:b","cacheStatus":"HIT","extra":[1,{"x":null}]}"#).is_ok());
    }

    #[test]
    fn an_odd_task_only_matters_when_it_is_the_one_asked_for() {
        let summary: Summary = serde_json::from_str(
            r#"{"id":"r","tasks":[{"taskId":"odd","cacheStatus":"HIT","hashDetails":{"command":"c","nodes":{"1":"x"}}},{"taskId":7},{},{"taskId":"ok","cacheStatus":"HIT"}]}"#,
        )
        .unwrap();

        assert!(matches!(find_task(&summary.tasks, "ok"), Some(Some(_))));
        assert!(matches!(find_task(&summary.tasks, "none"), Some(None)));
        assert!(matches!(find_task(&summary.tasks, "odd"), Some(Some(_))));
        assert!(serde_json::from_str::<Task>(find_task(&summary.tasks, "odd").unwrap().unwrap().get()).is_err());
    }
}
