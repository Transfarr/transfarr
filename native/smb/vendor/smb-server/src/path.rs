//! `SmbPath` — validated, normalized SMB path used between dispatcher and
//! backend.
//!
//! Construction is exclusively from a `&[u16]` (UTF-16LE-decoded) buffer, per
//! spec §7. The protocol layer turns wire bytes into `&[u16]`; this module
//! turns `&[u16]` into a path that backends can blindly trust.

use std::str::FromStr;

use crate::error::{SmbError, SmbResult};

/// A validated, component-list path. No `..`, no Windows-forbidden chars, no
/// traversal. A named $DATA stream is stored separately from filesystem components.
/// Always relative to the share root — the empty path is
/// the root.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SmbPath {
    components: Vec<String>,
    stream: Option<String>,
}

impl SmbPath {
    /// The share root.
    pub fn root() -> Self {
        Self::default()
    }

    /// Construct from a UTF-16 code-unit slice (already decoded from UTF-16LE
    /// wire bytes).
    pub fn from_utf16(units: &[u16]) -> SmbResult<Self> {
        // 1. Convert to UTF-8 lossily — but reject if conversion produced any
        //    replacement characters that didn't exist in the input. We test
        //    the round-trip: invalid surrogates are rejected.
        let s = decode_utf16_strict(units)?;
        s.parse()
    }

    fn parse_components(s: &str) -> SmbResult<Self> {
        // Strip a leading separator (clients sometimes prefix `\` or `/`).
        let trimmed = s
            .strip_prefix('\\')
            .or_else(|| s.strip_prefix('/'))
            .unwrap_or(s);
        if trimmed.is_empty() {
            return Ok(Self::root());
        }

        let (trimmed, stream) = match trimmed.split_once(':') {
            Some((base, suffix)) => {
                let (name, kind) = suffix.split_once(':').unwrap_or((suffix, "$DATA"));
                if !kind.eq_ignore_ascii_case("$DATA")
                    || name
                        .chars()
                        .any(|c| c.is_control() || "\\/<>:\"|?*".contains(c))
                    || name == "."
                    || name == ".."
                    || (name.is_empty() && suffix != ":$DATA")
                    || name.len() > 230
                {
                    return Err(SmbError::NameInvalid);
                }
                (
                    base,
                    if name.is_empty() {
                        None
                    } else {
                        Some(name.to_string())
                    },
                )
            }
            None => (trimmed, None),
        };

        // 2. Reject forbidden characters anywhere in the path.
        for ch in trimmed.chars() {
            if ch == '\0' || ('\u{0001}'..='\u{001F}').contains(&ch) {
                return Err(SmbError::NameInvalid);
            }
            // Allow `\` and `/` as separators, reject the rest of the
            // Windows-forbidden set anywhere.
            match ch {
                '<' | '>' | ':' | '"' | '|' | '?' | '*' => return Err(SmbError::NameInvalid),
                _ => {}
            }
        }

        // 3. Split on `\` or `/`; reject `..` and empty components; skip `.`.
        let mut components = Vec::new();
        for raw in trimmed.split(['\\', '/']).filter(|_| !trimmed.is_empty()) {
            if raw.is_empty() {
                // Doubled separator like `foo\\bar` — reject.
                return Err(SmbError::NameInvalid);
            }
            if raw == "." {
                continue;
            }
            if raw == ".." {
                return Err(SmbError::NameInvalid);
            }
            // 4. Reject reserved DOS device names.
            if is_reserved_dos_name(raw) {
                return Err(SmbError::NameInvalid);
            }
            components.push(raw.to_string());
        }
        Ok(Self { components, stream })
    }

    /// Path components in order. Empty for the root.
    pub fn components(&self) -> &[String] {
        &self.components
    }

    /// Is this the share root?
    pub fn is_root(&self) -> bool {
        self.components.is_empty() && self.stream.is_none()
    }

    pub fn stream(&self) -> Option<&str> {
        self.stream.as_deref()
    }

    /// Return the parent path, or `None` if this is the root.
    pub fn parent(&self) -> Option<SmbPath> {
        if self.is_root() {
            return None;
        }
        let mut parent = self.components.clone();
        parent.pop();
        Some(SmbPath {
            components: parent,
            stream: None,
        })
    }

    /// Return the last component, if any.
    pub fn file_name(&self) -> Option<&str> {
        self.components.last().map(|s| s.as_str())
    }

    /// Append a single, already-validated last component to this path.
    pub fn join(&self, last: &str) -> SmbResult<SmbPath> {
        if self.stream.is_some() {
            return Err(SmbError::NameInvalid);
        }
        // Run `last` through the same validator (treating it as a single-
        // component path).
        let extra = last.parse::<SmbPath>()?;
        let mut out = self.clone();
        out.components.extend(extra.components);
        out.stream = extra.stream;
        Ok(out)
    }

    /// Render as a backslash-separated string. Empty for root.
    pub fn display_backslash(&self) -> String {
        let mut path = self.components.join("\\");
        if let Some(stream) = &self.stream {
            path.push_str(&format!(":{stream}:$DATA"));
        }
        path
    }
}

impl FromStr for SmbPath {
    type Err = SmbError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse_components(s)
    }
}

impl std::fmt::Display for SmbPath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.is_root() {
            f.write_str("\\")
        } else {
            f.write_str(&self.display_backslash())
        }
    }
}

fn is_reserved_dos_name(s: &str) -> bool {
    // Strip extension before checking, e.g. "CON.txt" is also reserved.
    let stem = match s.rsplit_once('.') {
        Some((stem, _)) => stem,
        None => s,
    };
    let upper = stem.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL") || matches_com_or_lpt(&upper)
}

fn matches_com_or_lpt(s: &str) -> bool {
    if s.len() != 4 {
        return false;
    }
    let bytes = s.as_bytes();
    let prefix = &bytes[..3];
    let last = bytes[3] as char;
    if !matches!(last, '1'..='9') {
        return false;
    }
    prefix == b"COM" || prefix == b"LPT"
}

fn decode_utf16_strict(units: &[u16]) -> SmbResult<String> {
    // Reject unpaired surrogates explicitly. `String::from_utf16` does this
    // already; we surface its error as NameInvalid.
    String::from_utf16(units).map_err(|_| SmbError::NameInvalid)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn root_paths() {
        assert!("".parse::<SmbPath>().unwrap().is_root());
        assert!("\\".parse::<SmbPath>().unwrap().is_root());
        assert!("/".parse::<SmbPath>().unwrap().is_root());
        assert!(SmbPath::from_utf16(&utf16("")).unwrap().is_root());
    }

    #[test]
    fn simple_paths_split() {
        let p = "dir\\sub\\file.txt".parse::<SmbPath>().unwrap();
        assert_eq!(p.components(), &["dir", "sub", "file.txt"]);
        assert_eq!(p.display_backslash(), "dir\\sub\\file.txt");
        assert!(!p.is_root());
        assert_eq!(p.file_name(), Some("file.txt"));
    }

    #[test]
    fn forward_slash_accepted() {
        let p = "a/b/c".parse::<SmbPath>().unwrap();
        assert_eq!(p.components(), &["a", "b", "c"]);
    }

    #[test]
    fn dot_components_skipped() {
        let p = "a\\.\\b".parse::<SmbPath>().unwrap();
        assert_eq!(p.components(), &["a", "b"]);
    }

    #[test]
    fn parent_returns_one_component_less() {
        let p = "a\\b\\c".parse::<SmbPath>().unwrap();
        let parent = p.parent().unwrap();
        assert_eq!(parent.components(), &["a", "b"]);
        let grand = parent.parent().unwrap();
        assert_eq!(grand.components(), &["a"]);
        let root = grand.parent().unwrap();
        assert!(root.is_root());
        assert!(root.parent().is_none());
    }

    #[test]
    fn join_appends_component() {
        let p = "a".parse::<SmbPath>().unwrap();
        let q = p.join("b").unwrap();
        assert_eq!(q.components(), &["a", "b"]);
    }

    #[test]
    fn rejects_double_dot() {
        assert!("a\\..\\b".parse::<SmbPath>().is_err());
        assert!("..".parse::<SmbPath>().is_err());
    }

    #[test]
    fn rejects_double_separator() {
        assert!("a\\\\b".parse::<SmbPath>().is_err());
    }

    #[test]
    fn rejects_forbidden_chars() {
        for bad in ["a<b", "a>b", "a:b:c", "a\"b", "a|b", "a?b", "a*b"] {
            assert!(bad.parse::<SmbPath>().is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_control_chars() {
        let s = format!("a{}b", '\u{0001}');
        assert!(s.parse::<SmbPath>().is_err());
        let s = format!("a{}b", '\u{0000}');
        assert!(s.parse::<SmbPath>().is_err());
    }

    #[test]
    fn rejects_reserved_dos_names() {
        for bad in [
            "CON", "con", "PRN", "AUX", "NUL", "COM1", "LPT9", "Con.txt", "NUL.dat",
        ] {
            assert!(bad.parse::<SmbPath>().is_err(), "{bad}");
        }
    }

    #[test]
    fn allows_lookalike_names() {
        // Not reserved.
        assert!("CON1".parse::<SmbPath>().is_ok());
        assert!("LPT".parse::<SmbPath>().is_ok());
        assert!("LPT0".parse::<SmbPath>().is_ok()); // 0 is not in the 1-9 range
        assert!("NUL_FILE.txt".parse::<SmbPath>().is_ok());
    }

    #[test]
    fn rejects_unpaired_surrogate() {
        let units: [u16; 2] = [0xD800, 0x0061]; // unpaired high surrogate
        assert!(SmbPath::from_utf16(&units).is_err());
    }

    #[test]
    fn round_trip_via_utf16() {
        let p = SmbPath::from_utf16(&utf16("a\\b")).unwrap();
        assert_eq!(p.components(), &["a", "b"]);
    }

    #[test]
    fn named_streams_are_separate_from_confined_base_paths() {
        let p: SmbPath = "dir\\file:com.apple.lastuseddate#PS:$DATA".parse().unwrap();
        assert_eq!(p.components(), &["dir", "file"]);
        assert_eq!(p.stream(), Some("com.apple.lastuseddate#PS"));
        assert_eq!(
            p.display_backslash(),
            "dir\\file:com.apple.lastuseddate#PS:$DATA"
        );
        assert_eq!("file::$DATA".parse::<SmbPath>().unwrap().stream(), None);
        assert_eq!(
            "file:meta".parse::<SmbPath>().unwrap().stream(),
            Some("meta")
        );
        assert!(
            ":meta:$DATA"
                .parse::<SmbPath>()
                .unwrap()
                .components()
                .is_empty()
        );
        for bad in [
            "../file:meta",
            "dir:meta/file",
            "file:../meta",
            "file:..",
            "file:",
            "file:meta:$INDEX_ALLOCATION",
            "file:meta:$DATA:extra",
            "CON:meta",
            "file:meta\0",
        ] {
            assert!(bad.parse::<SmbPath>().is_err(), "{bad}");
        }
    }
}
