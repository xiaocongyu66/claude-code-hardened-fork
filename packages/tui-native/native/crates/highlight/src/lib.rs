//! Semantic, terminal-agnostic syntax highlighting.
//!
//! Source text is parsed with [`syntect`] using TextMate grammars, but the
//! output deliberately exposes semantic token kinds instead of colours or
//! fonts. A renderer decides how a [`TokenKind`] should look; this crate only
//! decides what a piece of text *is*.
//!
//! Grammars come from `two-face`, which extends syntect's built-in set with
//! TypeScript, TSX, TOML, and other bat-maintained syntaxes. The regex backend
//! is `fancy-regex`, so no native oniguruma dependency is required.
//!
//! Results are memoised in a byte-budget LRU keyed by
//! `(code hash, syntax, cache version)`. Unknown languages are not an error:
//! every line degrades to a single [`TokenKind::Plain`] span.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use syntect::parsing::{ParseState, ScopeStack, SyntaxReference, SyntaxSet};
use syntect::util::LinesWithEndings;

/// Default cache budget: 4 MiB of estimated payload bytes.
pub const DEFAULT_CACHE_BYTES: usize = 4 * 1024 * 1024;

/// Bump when token classification or grammar loading changes so stale cached
/// results are not reused.
pub const CACHE_VERSION: u32 = 1;

/// Semantic role of a span of text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TokenKind {
    Keyword,
    String,
    Comment,
    Number,
    Function,
    Type,
    Variable,
    Punctuation,
    Plain,
}

/// A run of text sharing one semantic kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyledSpan {
    pub text: String,
    pub kind: TokenKind,
}

/// One source line, split into semantic spans.
///
/// Line endings are not included. Empty lines have no spans.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StyledLine {
    pub spans: Vec<StyledSpan>,
}

impl StyledLine {
    /// Concatenate all span text.
    pub fn text(&self) -> String {
        self.spans.iter().map(|span| span.text.as_str()).collect()
    }
}

fn syntaxes() -> &'static SyntaxSet {
    static SYNTAXES: OnceLock<SyntaxSet> = OnceLock::new();
    SYNTAXES.get_or_init(two_face::syntax::extra_newlines)
}

/// Highlight `code` using a process-wide, 4 MiB cache.
///
/// `language_hint` may be a language name (`"rust"`), an extension (`"ts"`), a
/// file name (`"main.py"`), or a path (`"src/app.ts"`). Unknown hints degrade
/// to [`TokenKind::Plain`]. When the hint is absent, a small content sniff
/// (shebang, `fn main`, `def ...:`) is used before giving up.
pub fn highlight_lines(code: &str, language_hint: Option<&str>) -> Vec<StyledLine> {
    let mutex = highlighter();
    let mut highlighter = match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    highlighter.highlight(code, language_hint)
}

fn highlighter() -> &'static Mutex<Highlighter> {
    static GLOBAL: OnceLock<Mutex<Highlighter>> = OnceLock::new();
    GLOBAL.get_or_init(|| Mutex::new(Highlighter::new()))
}

/// Load the grammar set and start the cache ahead of the first frame.
///
/// Deserialising the TextMate grammars costs tens of milliseconds (hundreds
/// in an unoptimised build). Calling this once at startup keeps the first code
/// block from paying that cost, mirroring how Ink loads `cli-highlight`
/// behind a Suspense boundary.
pub fn warm_up() {
    let _ = syntaxes();
    let _ = highlighter();
}

/// Resolve a language hint (or content sniff) to a syntax name.
///
/// Returns `None` for an explicitly unknown hint or unrecognisable content.
pub fn detect_language(language_hint: Option<&str>, code: &str) -> Option<String> {
    if let Some(hint) = language_hint.map(str::trim).filter(|hint| !hint.is_empty()) {
        return find_syntax(hint).map(|syntax| syntax.name.clone());
    }
    sniff_language(code).map(str::to_owned)
}

fn find_syntax(hint: &str) -> Option<&'static SyntaxReference> {
    let set = syntaxes();

    if let Some(syntax) = find_alias(hint) {
        return Some(syntax);
    }

    // Filenames and paths: try the bare token first (covers "Makefile",
    // ".bashrc", and language names), then the file name and extension.
    if let Some(syntax) = set.find_syntax_by_token(hint) {
        return Some(syntax);
    }
    if let Some(name) = Path::new(hint).file_name().and_then(|name| name.to_str())
        && name != hint
        && let Some(syntax) = set.find_syntax_by_token(name)
    {
        return Some(syntax);
    }
    if let Some(extension) = Path::new(hint).extension().and_then(|ext| ext.to_str()) {
        if let Some(syntax) = find_alias(extension) {
            return Some(syntax);
        }
        if let Some(syntax) = set.find_syntax_by_extension(extension) {
            return Some(syntax);
        }
    }
    None
}

/// A handful of aliases that `find_syntax_by_token` cannot infer (generic
/// names without a matching extension).
fn find_alias(hint: &str) -> Option<&'static SyntaxReference> {
    let name = match hint.to_ascii_lowercase().as_str() {
        "shell" | "sh" | "bash" | "zsh" => "Bourne Again Shell (bash)",
        "text" | "txt" | "plain" | "plaintext" => "Plain Text",
        // No dedicated JSX grammar ships with two-face; the JavaScript
        // grammar is the closest available fallback.
        "jsx" => "JavaScript",
        "tsx" => "TypeScriptReact",
        "typescript" => "TypeScript",
        "javascript" => "JavaScript",
        "python" => "Python",
        "rust" => "Rust",
        _ => return None,
    };
    syntaxes().find_syntax_by_name(name)
}

fn sniff_language(code: &str) -> Option<&'static str> {
    let first_line = code.lines().next().unwrap_or("");
    if first_line.starts_with("#!") {
        if first_line.contains("python") {
            return Some("Python");
        }
        if first_line.contains("node") {
            return Some("JavaScript");
        }
        if first_line.contains("deno") {
            return Some("TypeScript");
        }
        if first_line.contains("bash")
            || first_line.contains("zsh")
            || first_line.contains(" sh")
            || first_line.ends_with("/sh")
        {
            return Some("Bourne Again Shell (bash)");
        }
    }

    // Only strong, language-specific markers; a wrong guess is worse than
    // plain text.
    if code.contains("fn main(") || code.contains("use std::") || code.contains("impl ") {
        return Some("Rust");
    }
    if code.contains("interface ") && code.contains(':') {
        return Some("TypeScript");
    }
    if code.contains("def ") && code.lines().any(|line| line.trim_end().ends_with(':')) {
        return Some("Python");
    }
    if code.contains("function ") || code.contains("=>") || code.contains("const ") {
        return Some("JavaScript");
    }
    None
}

/// A highlighter with its own cache. Useful when callers want statistics or a
/// different budget than the process-wide [`highlight_lines`] instance.
pub struct Highlighter {
    cache: ByteLru,
}

impl Default for Highlighter {
    fn default() -> Self {
        Self::new()
    }
}

impl Highlighter {
    pub fn new() -> Self {
        Self::with_cache_budget(DEFAULT_CACHE_BYTES)
    }

    pub fn with_cache_budget(bytes: usize) -> Self {
        Self {
            cache: ByteLru::new(bytes),
        }
    }

    /// Highlight `code`, consulting and filling the cache.
    pub fn highlight(&mut self, code: &str, language_hint: Option<&str>) -> Vec<StyledLine> {
        let syntax = language_hint
            .map(str::trim)
            .filter(|hint| !hint.is_empty())
            .map(find_syntax)
            .unwrap_or_else(|| {
                sniff_language(code).and_then(|name| syntaxes().find_syntax_by_name(name))
            });

        let key = CacheKey {
            code_hash: hash_code(code),
            language: syntax.map(|syntax| syntax.name.clone()),
            version: CACHE_VERSION,
        };

        if let Some(lines) = self.cache.get(&key) {
            return lines.clone();
        }

        let lines = match syntax {
            Some(syntax) => highlight_with_syntax(code, syntax),
            None => plain_lines(code),
        };
        self.cache.insert(key, lines.clone());
        lines
    }

    pub fn cache_len(&self) -> usize {
        self.cache.entries.len()
    }

    pub fn cache_bytes(&self) -> usize {
        self.cache.used
    }

    pub fn cache_budget(&self) -> usize {
        self.cache.budget
    }

    pub fn cache_hits(&self) -> u64 {
        self.cache.hits
    }

    pub fn cache_misses(&self) -> u64 {
        self.cache.misses
    }

    pub fn clear_cache(&mut self) {
        self.cache.clear();
    }
}

fn highlight_with_syntax(code: &str, syntax: &SyntaxReference) -> Vec<StyledLine> {
    let set = syntaxes();
    let mut state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut lines = Vec::new();

    for line in LinesWithEndings::from(code) {
        let Ok(ops) = state.parse_line(line, set) else {
            // A grammar hiccup must never lose the caller's text.
            return plain_lines(code);
        };
        let mut spans: Vec<StyledSpan> = Vec::new();
        let mut last = 0usize;

        for (position, op) in &ops {
            let position = (*position).min(line.len());
            if position > last {
                let text = &line[last..position];
                let kind = classify(stack.as_slice(), text);
                push_span(&mut spans, text, kind);
            }
            let _ = stack.apply(op);
            last = position;
        }
        if last < line.len() {
            let text = &line[last..];
            let kind = classify(stack.as_slice(), text);
            push_span(&mut spans, text, kind);
        }

        trim_line_ending(&mut spans);
        lines.push(StyledLine { spans });
    }
    lines
}

fn plain_lines(code: &str) -> Vec<StyledLine> {
    code.lines()
        .map(|line| StyledLine {
            spans: if line.is_empty() {
                Vec::new()
            } else {
                vec![StyledSpan {
                    text: line.to_owned(),
                    kind: TokenKind::Plain,
                }]
            },
        })
        .collect()
}

fn push_span(spans: &mut Vec<StyledSpan>, text: &str, kind: TokenKind) {
    if text.is_empty() {
        return;
    }
    if let Some(last) = spans.last_mut()
        && last.kind == kind
    {
        last.text.push_str(text);
        return;
    }
    spans.push(StyledSpan {
        text: text.to_owned(),
        kind,
    });
}

/// Strip a trailing `\n` or `\r\n` from the final span of a line.
fn trim_line_ending(spans: &mut Vec<StyledSpan>) {
    let Some(last) = spans.last_mut() else {
        return;
    };
    let trimmed_len = last.text.trim_end_matches(['\r', '\n']).len();
    last.text.truncate(trimmed_len);
    if last.text.is_empty() {
        spans.pop();
    }
}

fn rank(kind: TokenKind) -> u8 {
    match kind {
        TokenKind::Comment => 0,
        TokenKind::String => 1,
        TokenKind::Keyword => 2,
        TokenKind::Number => 3,
        TokenKind::Function => 4,
        TokenKind::Type => 5,
        TokenKind::Variable => 6,
        TokenKind::Punctuation => 7,
        TokenKind::Plain => 8,
    }
}

/// Pick the most specific semantic kind present in the scope stack.
///
/// TextMate stacks are outer-to-inner, and inner scopes are not always the
/// most meaningful (e.g. a string's closing quote is both `string.quoted` and
/// `punctuation.definition.string`). Ranking by category avoids that trap.
fn classify(scopes: &[syntect::parsing::Scope], text: &str) -> TokenKind {
    let mut best = TokenKind::Plain;
    let mut best_rank = rank(TokenKind::Plain);
    for scope in scopes {
        let name = scope.build_string();
        if let Some(kind) = classify_scope(&name, text)
            && rank(kind) < best_rank
        {
            best = kind;
            best_rank = rank(kind);
        }
    }
    best
}

fn classify_scope(scope: &str, text: &str) -> Option<TokenKind> {
    if scope.starts_with("comment") {
        Some(TokenKind::Comment)
    } else if scope.starts_with("string") {
        Some(TokenKind::String)
    } else if scope.starts_with("keyword.operator") {
        Some(TokenKind::Punctuation)
    } else if scope.starts_with("keyword") || scope.starts_with("storage.modifier") {
        Some(TokenKind::Keyword)
    } else if scope.starts_with("storage.type") {
        // Rust's grammar scopes both `let`/`fn` and `u32`/`Self` as
        // `storage.type.rust`; the token text disambiguates.
        if is_keyword_word(text) {
            Some(TokenKind::Keyword)
        } else {
            Some(TokenKind::Type)
        }
    } else if scope.starts_with("constant.numeric") {
        Some(TokenKind::Number)
    } else if scope.starts_with("constant.language") {
        Some(TokenKind::Keyword)
    } else if scope.starts_with("entity.name.function")
        || scope.starts_with("support.function")
        || scope.starts_with("variable.function")
    {
        Some(TokenKind::Function)
    } else if scope.starts_with("entity.name.type")
        || scope.starts_with("entity.name.class")
        || scope.starts_with("entity.name.struct")
        || scope.starts_with("entity.name.enum")
        || scope.starts_with("entity.name.interface")
        || scope.starts_with("entity.name.trait")
        || scope.starts_with("entity.name.impl")
        || scope.starts_with("entity.name.namespace")
        || scope.starts_with("entity.name.tag")
        || scope.starts_with("entity.other.inherited-class")
        || scope.starts_with("support.type")
        || scope.starts_with("support.class")
    {
        Some(TokenKind::Type)
    } else if scope.starts_with("variable") {
        Some(TokenKind::Variable)
    } else if scope.starts_with("punctuation") {
        Some(TokenKind::Punctuation)
    } else {
        None
    }
}

/// Words that TextMate grammars commonly scope as `storage.type` even though
/// they are keywords. Kept lowercase; case-sensitive matching keeps `Self`
/// classified as a type.
fn is_keyword_word(text: &str) -> bool {
    matches!(
        text,
        "fn" | "let"
            | "const"
            | "static"
            | "struct"
            | "enum"
            | "trait"
            | "impl"
            | "mod"
            | "use"
            | "pub"
            | "mut"
            | "unsafe"
            | "extern"
            | "type"
            | "where"
            | "async"
            | "await"
            | "move"
            | "ref"
            | "dyn"
            | "crate"
            | "super"
            | "self"
            | "class"
            | "interface"
            | "function"
            | "var"
            | "import"
            | "export"
            | "extends"
            | "implements"
            | "private"
            | "public"
            | "protected"
            | "readonly"
            | "declare"
            | "namespace"
            | "abstract"
            | "def"
            | "lambda"
            | "global"
            | "nonlocal"
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    code_hash: u64,
    language: Option<String>,
    version: u32,
}

fn hash_code(code: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    code.hash(&mut hasher);
    hasher.finish()
}

fn estimate_bytes(lines: &[StyledLine]) -> usize {
    let span_overhead = std::mem::size_of::<StyledSpan>();
    let line_overhead = std::mem::size_of::<StyledLine>();
    lines
        .iter()
        .map(|line| {
            line_overhead
                + line
                    .spans
                    .iter()
                    .map(|span| span_overhead + span.text.len())
                    .sum::<usize>()
        })
        .sum()
}

struct Entry {
    lines: Vec<StyledLine>,
    bytes: usize,
    stamp: u64,
}

/// Byte-budget LRU. Eviction order is approximated by a monotonically
/// increasing access stamp, which is exact for this workload and avoids an
/// extra intrusive list.
struct ByteLru {
    entries: HashMap<CacheKey, Entry>,
    budget: usize,
    used: usize,
    clock: u64,
    hits: u64,
    misses: u64,
}

impl ByteLru {
    fn new(budget: usize) -> Self {
        Self {
            entries: HashMap::new(),
            budget,
            used: 0,
            clock: 0,
            hits: 0,
            misses: 0,
        }
    }

    fn get(&mut self, key: &CacheKey) -> Option<&Vec<StyledLine>> {
        self.clock += 1;
        let stamp = self.clock;
        match self.entries.get_mut(key) {
            Some(entry) => {
                entry.stamp = stamp;
                self.hits += 1;
                Some(&entry.lines)
            }
            None => {
                self.misses += 1;
                None
            }
        }
    }

    fn insert(&mut self, key: CacheKey, lines: Vec<StyledLine>) {
        let bytes = estimate_bytes(&lines);
        // An item that can never fit is simply not cached.
        if bytes > self.budget {
            return;
        }

        self.clock += 1;
        if let Some(old) = self.entries.remove(&key) {
            self.used = self.used.saturating_sub(old.bytes);
        }
        self.used += bytes;
        self.entries.insert(
            key,
            Entry {
                lines,
                bytes,
                stamp: self.clock,
            },
        );

        while self.used > self.budget {
            let victim = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.stamp)
                .map(|(key, _)| key.clone());
            let Some(victim) = victim else {
                break;
            };
            if let Some(entry) = self.entries.remove(&victim) {
                self.used = self.used.saturating_sub(entry.bytes);
            }
        }
    }

    fn clear(&mut self) {
        self.entries.clear();
        self.used = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUST: &str = "fn main() {\n    let msg = \"hi\"; // 注释\n}\n";
    const TS: &str = "const greeting: string = \"hello\";\n";
    const PY: &str = "def greet(name):\n    # 注释\n    return \"hi \" + name\n";

    fn kinds(lines: &[StyledLine]) -> Vec<TokenKind> {
        lines
            .iter()
            .flat_map(|line| line.spans.iter().map(|span| span.kind))
            .collect()
    }

    fn span_text(lines: &[StyledLine], kind: TokenKind) -> String {
        lines
            .iter()
            .flat_map(|line| line.spans.iter())
            .filter(|span| span.kind == kind)
            .map(|span| span.text.as_str())
            .collect()
    }

    #[test]
    fn rust_keywords_and_strings() {
        let lines = highlight_lines(RUST, Some("main.rs"));
        let kinds = kinds(&lines);
        assert!(kinds.contains(&TokenKind::Keyword), "{kinds:?}");
        assert!(kinds.contains(&TokenKind::String), "{kinds:?}");
        assert!(kinds.contains(&TokenKind::Comment), "{kinds:?}");
        // `fn` and `let` are both `storage.type.rust` in this grammar.
        let keywords = span_text(&lines, TokenKind::Keyword);
        assert!(keywords.contains("fn"), "{keywords:?}");
        assert!(keywords.contains("let"), "{keywords:?}");
        assert_eq!(span_text(&lines, TokenKind::String), "\"hi\"");
    }

    #[test]
    fn typescript_keywords_and_strings() {
        let lines = highlight_lines(TS, Some("app.ts"));
        let kinds = kinds(&lines);
        assert!(kinds.contains(&TokenKind::Keyword), "{kinds:?}");
        assert!(kinds.contains(&TokenKind::String), "{kinds:?}");
        assert!(span_text(&lines, TokenKind::Keyword).contains("const"));
        assert_eq!(span_text(&lines, TokenKind::String), "\"hello\"");
        assert_eq!(span_text(&lines, TokenKind::Type), "string");
    }

    #[test]
    fn python_keywords_and_strings() {
        let lines = highlight_lines(PY, Some("greet.py"));
        let kinds = kinds(&lines);
        assert!(kinds.contains(&TokenKind::Keyword), "{kinds:?}");
        assert!(kinds.contains(&TokenKind::String), "{kinds:?}");
        let keywords = span_text(&lines, TokenKind::Keyword);
        assert!(keywords.contains("def"), "{keywords:?}");
        assert!(keywords.contains("return"), "{keywords:?}");
        assert_eq!(span_text(&lines, TokenKind::String), "\"hi \"");
        assert!(span_text(&lines, TokenKind::Comment).contains("注释"));
    }

    #[test]
    fn numbers_are_classified() {
        let lines = highlight_lines("let n: u32 = 42;", Some("rs"));
        assert_eq!(span_text(&lines, TokenKind::Number), "42");
        assert_eq!(span_text(&lines, TokenKind::Type), "u32");
        assert_eq!(span_text(&lines, TokenKind::Keyword), "let");
    }

    #[test]
    fn language_names_extensions_and_paths() {
        assert_eq!(detect_language(Some("rust"), ""), Some("Rust".to_string()));
        assert_eq!(
            detect_language(Some("main.rs"), ""),
            Some("Rust".to_string())
        );
        assert_eq!(
            detect_language(Some("src/app.tsx"), ""),
            Some("TypeScriptReact".to_string())
        );
        assert_eq!(
            detect_language(Some("script.py"), ""),
            Some("Python".to_string())
        );
        assert_eq!(
            detect_language(Some("Cargo.toml"), ""),
            Some("TOML".to_string())
        );
    }

    #[test]
    fn unknown_language_degrades_to_plain() {
        let code = "fn main() { let x = \"not highlighted\"; }";
        let lines = highlight_lines(code, Some("definitely-not-a-language"));
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].spans.len(), 1);
        assert_eq!(lines[0].spans[0].kind, TokenKind::Plain);
        assert_eq!(lines[0].spans[0].text, code);

        let lines = highlight_lines("just some prose", None);
        assert_eq!(lines[0].spans.len(), 1);
        assert_eq!(lines[0].spans[0].kind, TokenKind::Plain);
    }

    #[test]
    fn content_sniffing_without_a_hint() {
        assert_eq!(
            detect_language(None, "fn main() {\n    println!(\"hi\");\n}\n"),
            Some("Rust".to_string())
        );
        assert_eq!(
            detect_language(None, "def greet(name):\n    return name\n"),
            Some("Python".to_string())
        );
        assert_eq!(detect_language(None, "hello world"), None);
    }

    #[test]
    fn cache_hits_avoid_rehighlighting() {
        let mut highlighter = Highlighter::new();
        let first = highlighter.highlight(RUST, Some("rust"));
        assert_eq!(highlighter.cache_misses(), 1);
        assert_eq!(highlighter.cache_hits(), 0);
        assert_eq!(highlighter.cache_len(), 1);

        let second = highlighter.highlight(RUST, Some("main.rs"));
        assert_eq!(first, second);
        assert_eq!(highlighter.cache_misses(), 1);
        assert_eq!(highlighter.cache_hits(), 1);
        assert!(highlighter.cache_bytes() > 0);
    }

    #[test]
    fn different_languages_are_distinct_cache_entries() {
        let mut highlighter = Highlighter::new();
        highlighter.highlight("def x(): pass", Some("python"));
        highlighter.highlight("def x(): pass", Some("rust"));
        assert_eq!(highlighter.cache_len(), 2);
        assert_eq!(highlighter.cache_misses(), 2);
    }

    #[test]
    fn lru_evicts_once_the_budget_is_exceeded() {
        let mut probe = Highlighter::new();
        let alpha = "fn alpha() { let a = \"alpha\"; }\n";
        let beta = "fn beta()  { let b = \"beta\";  }\n";
        probe.highlight(alpha, Some("rust"));
        let one_entry = probe.cache_bytes();

        let mut highlighter = Highlighter::with_cache_budget(one_entry + one_entry / 2);
        highlighter.highlight(alpha, Some("rust"));
        assert_eq!(highlighter.cache_len(), 1);
        highlighter.highlight(beta, Some("rust"));
        assert_eq!(highlighter.cache_len(), 1);
        assert_eq!(highlighter.cache_misses(), 2);

        // `alpha` was the least recently used entry, so it must be gone.
        highlighter.highlight(alpha, Some("rust"));
        assert_eq!(highlighter.cache_misses(), 3);
        highlighter.highlight(alpha, Some("rust"));
        assert_eq!(highlighter.cache_hits(), 1);
        assert_eq!(highlighter.cache_len(), 1);
    }

    #[test]
    fn oversized_results_are_not_cached() {
        let mut highlighter = Highlighter::with_cache_budget(1);
        highlighter.highlight(RUST, Some("rust"));
        assert_eq!(highlighter.cache_len(), 0);
        highlighter.highlight(RUST, Some("rust"));
        assert_eq!(highlighter.cache_hits(), 0);
        assert_eq!(highlighter.cache_misses(), 2);
    }

    #[test]
    fn cjk_comments_preserve_text_and_width() {
        let code = "let x = 1; // 中文注释，宽度正常\n";
        let lines = highlight_lines(code, Some("rust"));
        let rendered = lines[0].text();
        assert_eq!(rendered, "let x = 1; // 中文注释，宽度正常");

        let comment: Vec<&StyledSpan> = lines[0]
            .spans
            .iter()
            .filter(|span| span.kind == TokenKind::Comment)
            .collect();
        assert!(!comment.is_empty());
        assert!(comment.iter().any(|span| span.text.contains("中文注释")));

        // Multibyte characters survive as whole chars: width is determined by
        // display width, never by byte length.
        let comment_text: String = comment.iter().map(|span| span.text.as_str()).collect();
        assert_eq!(
            comment_text.chars().count(),
            "// 中文注释，宽度正常".chars().count()
        );
        assert!(comment_text.len() > comment_text.chars().count());
    }

    #[test]
    fn line_endings_and_empty_lines() {
        let lines = highlight_lines("fn a() {}\r\n\r\nfn b() {}\r\n", Some("rust"));
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].text(), "fn a() {}");
        assert!(lines[1].spans.is_empty());
        assert_eq!(lines[2].text(), "fn b() {}");

        assert!(highlight_lines("", Some("rust")).is_empty());
    }

    #[test]
    fn tsx_and_jsx_hints_resolve() {
        assert_eq!(
            detect_language(Some("view.tsx"), ""),
            Some("TypeScriptReact".to_string())
        );
        assert_eq!(
            detect_language(Some("component.jsx"), ""),
            Some("JavaScript".to_string())
        );
    }
}
