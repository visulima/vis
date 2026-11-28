//! A small tree and the writer for what `toXML` of `jstoxml` makes of it, with the options `serializeBomToXml`
//! (`src/sbom/cyclonedx.ts`) passes: the default header, two spaces of indent, self-closing empty tags.
//!
//! The tree is the one the Node code hands to the library, element by element. The library escapes `<`, `>`, `&`
//! and `"` in text and in attribute values, with two exceptions that make its output depend on what the text
//! looks like:
//!
//! - a value that starts with `<![CDATA[` is written as it is, so a description of `<![CDATA[x]]><b a="1"/>` adds an
//!   element to the document;
//! - each of the four characters is left alone when a run of word characters and `#` and then a `;` follow it (to keep
//!   `&amp;` from becoming `&amp;amp;`), so `&amp;` stays as it is, and so do `&copy;`, which is no entity of XML, and
//!   `<b;`, which is no well-formed text.
//!
//! This writer reproduces the library where its output is well-formed and holds no markup that the value did not
//! escape: a predefined entity that is left alone (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`), a `"` in a text
//! (not in an attribute value), and a `>` that does not end a `]]`. It reports [`Unescapable`] for a value that is anything else the library leaves as it is,
//! and the caller hands the run to Node, which writes what the library writes. Every other value is escaped in full,
//! and the layout is the library's:
//!
//! - an element with children closes on its own line, and an element with text closes right after it;
//! - an element with no content, or with content that wrote nothing, is one self-closing tag, and an element whose
//!   content is an empty list is not written at all.

/// A value that the library leaves as it is in a way this writer does not reproduce (see the module documentation).
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Unescapable;

/// One element: a name, attributes in order, and what it holds.
pub(super) struct Element {
    name: &'static str,
    attributes: Vec<(&'static str, String)>,
    content: Content,
}

enum Content {
    /// Nothing between the tags.
    Empty,
    Text(String),
    /// A list of elements. An empty list makes the element vanish.
    Children(Vec<Element>),
}

impl Element {
    pub(super) fn text(name: &'static str, text: impl Into<String>) -> Self {
        Self { name, attributes: Vec::new(), content: Content::Text(text.into()) }
    }

    pub(super) fn empty(name: &'static str) -> Self {
        Self { name, attributes: Vec::new(), content: Content::Empty }
    }

    pub(super) fn parent(name: &'static str, children: Vec<Element>) -> Self {
        Self { name, attributes: Vec::new(), content: Content::Children(children) }
    }

    pub(super) fn with_attribute(mut self, name: &'static str, value: impl Into<String>) -> Self {
        self.attributes.push((name, value.into()));

        self
    }

    /// `toXML(root, { header: true, indent: "  ", selfCloseTags: true })`.
    pub(super) fn document(&self) -> Result<String, Unescapable> {
        Ok(format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>{}", self.write(0)?))
    }

    fn write(&self, depth: usize) -> Result<String, Unescapable> {
        let (written, has_children) = match &self.content {
            Content::Empty => (String::new(), false),
            Content::Text(text) => (escape(text, false)?, false),
            Content::Children(children) if children.is_empty() => return Ok(String::new()),
            Content::Children(children) => {
                (children.iter().map(|child| child.write(depth + 1)).collect::<Result<String, _>>()?, true)
            }
        };

        let indent = "  ".repeat(depth);
        let mut attributes = String::new();

        for (name, value) in &self.attributes {
            attributes.push_str(&format!(" {name}=\"{}\"", escape(value, true)?));
        }

        if written.is_empty() {
            return Ok(format!("\n{indent}<{}{attributes}/>", self.name));
        }

        // The library puts the closing tag on its own line when the content it wrote holds a `<`: the children of an
        // element do, and a text that was escaped in full does not.
        let close = if has_children { format!("\n{indent}") } else { String::new() };

        Ok(format!("\n{indent}<{}{attributes}>{written}{close}</{}>", self.name, self.name))
    }
}

/// The predefined entities of XML, which the library leaves alone when they are in the text already.
const ENTITIES: [&[u8]; 5] = [b"amp", b"lt", b"gt", b"quot", b"apos"];

/// The text as the library writes it, or [`Unescapable`] for a text that it leaves as it is in a way that is not
/// well-formed or that holds markup: one that starts with `<![CDATA[`, and one with a `<`, a `&` or a `>` after
/// `]]` and a run of `[A-Za-z0-9_#]` and a `;` after it, where the `&` is not a predefined entity (`&copy;`, `&#38;`),
/// or with a `"` of an attribute value followed so. A predefined entity, a `"` of a text and a `>` are kept as they are.
fn escape(text: &str, attribute: bool) -> Result<String, Unescapable> {
    if text.starts_with("<![CDATA[") {
        return Err(Unescapable);
    }

    let mut out = String::with_capacity(text.len());

    for (index, character) in text.char_indices() {
        let entity = match character {
            '<' => "&lt;",
            '>' => "&gt;",
            '&' => "&amp;",
            '"' => "&quot;",
            _ => {
                out.push(character);

                continue;
            }
        };

        let after = &text.as_bytes()[index + character.len_utf8()..];
        let run = after.iter().take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'#')).count();

        if after.get(run) != Some(&b';') {
            out.push_str(entity);
        } else if (character == '&' && ENTITIES.contains(&&after[..run]))
            || (character == '"' && !attribute)
            || (character == '>' && !text[..index].ends_with("]]"))
        {
            out.push(character);
        } else {
            return Err(Unescapable);
        }
    }

    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{escape, Element, Unescapable};

    fn text(value: &str) -> Result<String, Unescapable> {
        escape(value, false)
    }

    #[test]
    fn escapes_the_four_characters_in_full() {
        assert_eq!(text("a<b>c&d\"e'f"), Ok("a&lt;b&gt;c&amp;d&quot;e'f".to_owned()));
        // A space, a dot or the end ends the run before a `;`, which the library escapes as well.
        assert_eq!(text("& a; <. ;"), Ok("&amp; a; &lt;. ;".to_owned()));
        assert_eq!(text("x<![CDATA[<b>"), Ok("x&lt;![CDATA[&lt;b&gt;".to_owned()));
        assert_eq!(text(""), Ok(String::new()));
    }

    #[test]
    fn a_predefined_entity_and_a_quote_of_a_text_are_left_as_the_library_leaves_them() {
        assert_eq!(
            text("fish &amp; chips &lt;b&gt; &quot;x&quot; &apos;"),
            Ok("fish &amp; chips &lt;b&gt; &quot;x&quot; &apos;".to_owned())
        );
        assert_eq!(text("say \"hi\";"), Ok("say &quot;hi\";".to_owned()));
        // A `>` that the library leaves alone is no markup, unless it closes a `]]`, which a text must not hold.
        assert_eq!(text("Ann <a@b.c>; Bob"), Ok("Ann &lt;a@b.c>; Bob".to_owned()));
        // The quote of an attribute value would end the value.
        assert_eq!(escape("say \"hi\";", true), Err(Unescapable));
        assert_eq!(escape("&amp;", true), Ok("&amp;".to_owned()));
    }

    #[test]
    fn a_value_the_library_would_leave_as_it_is_in_any_other_way_is_unescapable() {
        for value in [
            "<![CDATA[raw]]>",
            "<![CDATA[x]]><b a=\"1\"/>",
            "&#38;",
            "&#x26;",
            "&copy;",
            "&AMP;",
            "a<b;c",
            "]]>x;",
            "tail &x_1;",
            "<;",
            "&;",
        ] {
            assert_eq!(text(value), Err(Unescapable), "{value}");
        }
    }

    #[test]
    fn writes_like_the_library() {
        let tree = Element::parent(
            "bom",
            vec![
                Element::parent(
                    "a",
                    vec![
                        Element::text("b", "x < y & \"z\" &amp;"),
                        Element::text("c", ""),
                        Element::empty("d").with_attribute("k", "v\""),
                    ],
                ),
                Element::parent("gone", Vec::new()),
                Element::parent("hollow", vec![Element::parent("inner", Vec::new())]),
            ],
        )
        .with_attribute("version", "1");

        assert_eq!(
            tree.document(),
            Ok("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<bom version=\"1\">\n  <a>\n    <b>x &lt; y &amp; &quot;z&quot; &amp;</b>\n    <c/>\n    <d k=\"v&quot;\"/>\n  </a>\n  <hollow/>\n</bom>".to_owned())
        );

        let bad = Element::parent("bom", vec![Element::text("t", "a&copy;b")]);

        assert_eq!(bad.document(), Err(Unescapable));
        assert_eq!(Element::empty("d").with_attribute("k", "\"x;").document(), Err(Unescapable));
    }
}
