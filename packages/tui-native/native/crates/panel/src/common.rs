//! Helpers shared by the task and agent panels.

use cch_tui_proto::Extra;
use serde_json::Value;

/// Read a non-empty string field.
pub(crate) fn string_field<'a>(map: &'a Extra, key: &str) -> Option<&'a str> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

/// Read a non-negative integer field, tolerating numeric strings and floats.
pub(crate) fn u64_field(map: &Extra, key: &str) -> Option<u64> {
    let value = map.get(key)?;
    match value {
        Value::Number(number) => number
            .as_u64()
            .or_else(|| number.as_f64().filter(|n| *n >= 0.0).map(|n| n as u64)),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

/// The `usage.duration_ms` (or a top-level `duration_ms`) carried by task
/// progress and notification frames.
pub(crate) fn duration_ms(map: &Extra) -> Option<u64> {
    map.get("usage")
        .and_then(Value::as_object)
        .and_then(|usage| u64_field(usage, "duration_ms"))
        .or_else(|| u64_field(map, "duration_ms"))
}

/// First non-empty string among `keys`.
pub(crate) fn first_string(map: &Extra, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| string_field(map, key).map(ToOwned::to_owned))
}

/// Render a JSON value (string, text-block array or `{text}` object) as text.
pub(crate) fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| item.as_str())
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
        Value::Object(map) => map
            .get("text")
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(ToOwned::to_owned),
        _ => None,
    }
}

/// Collapse newlines/tabs and cut `text` to `width` display columns, ending
/// with `…` when anything was removed. `width == 0` yields an empty string.
pub(crate) fn truncate_line(text: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let single: String = text
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    let mut lines = cch_tui_ui::wrap_text(&single, width);
    if lines.len() <= 1 {
        return lines.pop().unwrap_or_default();
    }
    // Reserve one column for the ellipsis and re-cut the first wrapped line.
    let first = lines.swap_remove(0);
    let mut head = cch_tui_ui::wrap_text(&first, width.saturating_sub(1))
        .pop()
        .unwrap_or_default();
    head.push('…');
    head
}

/// Shorten an id for use as a fallback label.
pub(crate) fn short_id(id: &str) -> String {
    let mut short: String = id.chars().take(8).collect();
    if id.chars().count() > 8 {
        short.push('…');
    }
    short
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_keeps_short_text_and_marks_long_text() {
        assert_eq!(truncate_line("done", 10), "done");
        assert_eq!(truncate_line("", 4), "");
        assert_eq!(truncate_line("abcdefgh", 0), "");

        let cut = truncate_line("abcdefghij", 5);
        assert!(cut.ends_with('…'), "{cut:?}");
        assert!(cch_tui_ui::wrap_text(&cut, 5).len() == 1, "{cut:?}");

        assert_eq!(truncate_line("a\nb", 8), "a b");
    }

    #[test]
    fn u64_field_tolerates_numbers_and_strings() {
        let extra: Extra = serde_json::from_str(r#"{"a":5,"b":"7","c":-1,"d":1.5}"#).unwrap();
        assert_eq!(u64_field(&extra, "a"), Some(5));
        assert_eq!(u64_field(&extra, "b"), Some(7));
        assert_eq!(u64_field(&extra, "c"), None);
        assert_eq!(u64_field(&extra, "d"), Some(1));
        assert_eq!(u64_field(&extra, "missing"), None);
    }
}
