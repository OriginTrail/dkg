//! Bounded, source-spanned S-expression admission IR.
//!
//! This crate parses data only. It deliberately contains no evaluator,
//! environment, function application, host imports, or dynamic dispatch.

use lexpr::{Value, datum, parse::Parser};

/// Default maximum source size accepted by the admission parser.
pub const DEFAULT_MAX_SOURCE_BYTES: usize = 256 * 1024;
/// Absolute V1 source ceiling.
pub const HARD_MAX_SOURCE_BYTES: usize = 1024 * 1024;
/// Default maximum generic datum count.
pub const DEFAULT_MAX_NODES: usize = 100_000;
/// Default maximum semantic nesting depth.
pub const DEFAULT_MAX_DEPTH: usize = 64;
/// Maximum identifier size in bytes.
pub const MAX_IDENTIFIER_BYTES: usize = 256;
/// Maximum inline string size in bytes.
pub const MAX_STRING_BYTES: usize = 64 * 1024;

/// Parser/admission bounds, always clamped to V1 hard ceilings.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AdmissionLimits {
    /// Maximum source bytes.
    pub max_source_bytes: usize,
    /// Maximum generic datum nodes.
    pub max_nodes: usize,
    /// Maximum semantic nesting.
    pub max_depth: usize,
}

impl Default for AdmissionLimits {
    fn default() -> Self {
        Self {
            max_source_bytes: DEFAULT_MAX_SOURCE_BYTES,
            max_nodes: DEFAULT_MAX_NODES,
            max_depth: DEFAULT_MAX_DEPTH,
        }
    }
}

impl AdmissionLimits {
    fn validate(self) -> Result<Self, Diagnostic> {
        if self.max_source_bytes == 0 || self.max_source_bytes > HARD_MAX_SOURCE_BYTES {
            return Err(Diagnostic::new(
                DiagnosticCode::SourceTooLarge,
                SourceSpan::ZERO,
                "configured source limit exceeds the V1 ceiling",
            ));
        }
        if self.max_nodes == 0 || self.max_nodes > DEFAULT_MAX_NODES {
            return Err(Diagnostic::new(
                DiagnosticCode::NodeLimit,
                SourceSpan::ZERO,
                "configured node limit exceeds the V1 ceiling",
            ));
        }
        if self.max_depth == 0 || self.max_depth > DEFAULT_MAX_DEPTH {
            return Err(Diagnostic::new(
                DiagnosticCode::DepthLimit,
                SourceSpan::ZERO,
                "configured nesting limit exceeds the V1 ceiling",
            ));
        }
        Ok(self)
    }
}

/// One-based source position as reported by `lexpr`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SourcePosition {
    /// One-based line.
    pub line: usize,
    /// Zero-based UTF-8 column.
    pub column: usize,
}

/// Source range used by stable diagnostics.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SourceSpan {
    /// Inclusive start.
    pub start: SourcePosition,
    /// Exclusive end.
    pub end: SourcePosition,
}

impl SourceSpan {
    /// Synthetic zero span for failures before parsing.
    pub const ZERO: Self = Self {
        start: SourcePosition { line: 1, column: 0 },
        end: SourcePosition { line: 1, column: 0 },
    };
}

impl From<datum::Span> for SourceSpan {
    fn from(value: datum::Span) -> Self {
        Self {
            start: SourcePosition {
                line: value.start().line(),
                column: value.start().column(),
            },
            end: SourcePosition {
                line: value.end().line(),
                column: value.end().column(),
            },
        }
    }
}

/// A typed value paired with its source range.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Spanned<T> {
    /// Typed value.
    pub value: T,
    /// Original source range.
    pub span: SourceSpan,
}

/// Stable diagnostic severity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Severity {
    /// Admission cannot continue.
    Error,
    /// Plan can be admitted but requires operator attention.
    Warning,
}

/// Stable admission codes. Human messages are intentionally non-contractual.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiagnosticCode {
    /// Source exceeded its byte ceiling.
    SourceTooLarge,
    /// Source was not accepted UTF-8.
    InvalidUtf8,
    /// Generic parser rejected the document.
    Parse,
    /// More than one top-level datum was supplied.
    TopLevelCount,
    /// Top-level datum was not a strategy.
    ExpectedStrategy,
    /// Generic datum count was exhausted.
    NodeLimit,
    /// Semantic nesting was exhausted.
    DepthLimit,
    /// Unsupported atom or improper list.
    UnsupportedDatum,
    /// Identifier exceeded the V1 size bound.
    IdentifierTooLong,
    /// Inline string exceeded the V1 size bound.
    StringTooLong,
    /// Required strategy header was absent or malformed.
    InvalidHeader,
    /// Unknown executable-looking form.
    UnknownForm,
    /// Registered operation was not exact-version pinned.
    AdapterOperationMustBePinned,
    /// Registered operation arguments did not match its schema.
    SchemaMismatch,
    /// A repeating construct had no static bound.
    UnboundedRepeat,
    /// A protected effect had no approval path.
    ApprovalGap,
    /// A temporary or one-shot action appeared under automatic retry.
    TemporaryRetry,
    /// Parallel branches claimed the same exclusive resource.
    ParallelConflict,
    /// Delegation would broaden authority.
    AuthorityBroadening,
}

impl DiagnosticCode {
    /// Stable string passed across host boundaries.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SourceTooLarge => "IR_SOURCE_TOO_LARGE",
            Self::InvalidUtf8 => "IR_INVALID_UTF8",
            Self::Parse => "IR_PARSE",
            Self::TopLevelCount => "IR_TOP_LEVEL_COUNT",
            Self::ExpectedStrategy => "IR_EXPECTED_STRATEGY",
            Self::NodeLimit => "IR_NODE_LIMIT",
            Self::DepthLimit => "IR_DEPTH_LIMIT",
            Self::UnsupportedDatum => "IR_UNSUPPORTED_DATUM",
            Self::IdentifierTooLong => "IR_IDENTIFIER_TOO_LONG",
            Self::StringTooLong => "IR_STRING_TOO_LONG",
            Self::InvalidHeader => "IR_INVALID_HEADER",
            Self::UnknownForm => "IR_UNKNOWN_FORM",
            Self::AdapterOperationMustBePinned => "IR_ADAPTER_OPERATION_MUST_BE_PINNED",
            Self::SchemaMismatch => "IR_SCHEMA_MISMATCH",
            Self::UnboundedRepeat => "IR_UNBOUNDED_REPEAT",
            Self::ApprovalGap => "IR_APPROVAL_GAP",
            Self::TemporaryRetry => "IR_TEMPORARY_RETRY",
            Self::ParallelConflict => "IR_PARALLEL_CONFLICT",
            Self::AuthorityBroadening => "IR_AUTHORITY_BROADENING",
        }
    }
}

/// One admission diagnostic.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Diagnostic {
    /// Stable machine code.
    pub code: DiagnosticCode,
    /// Severity.
    pub severity: Severity,
    /// Primary source range.
    pub primary: SourceSpan,
    /// Human-readable explanation.
    pub message: String,
    /// Optional remediation hint.
    pub help: Option<String>,
}

impl Diagnostic {
    /// Constructs an error diagnostic.
    #[must_use]
    pub fn new(code: DiagnosticCode, primary: SourceSpan, message: impl Into<String>) -> Self {
        Self {
            code,
            severity: Severity::Error,
            primary,
            message: message.into(),
            help: None,
        }
    }

    /// Adds a remediation hint.
    #[must_use]
    pub fn with_help(mut self, help: impl Into<String>) -> Self {
        self.help = Some(help.into());
        self
    }
}

/// Atom accepted by the declarative strategy grammar.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum Atom {
    /// Identifier or enum-like symbol.
    Symbol(String),
    /// Inline UTF-8 string.
    String(String),
    /// Signed integer. Floats, NaN and infinity are rejected.
    Integer(i64),
    /// Boolean literal.
    Bool(bool),
}

impl Atom {
    /// Returns a symbol when this atom is one.
    #[must_use]
    pub fn as_symbol(&self) -> Option<&str> {
        match self {
            Self::Symbol(value) => Some(value),
            _ => None,
        }
    }

    /// Stable textual form used for typed call arguments.
    #[must_use]
    pub fn canonical_text(&self) -> String {
        match self {
            Self::Symbol(value) => format!("s:{value}"),
            Self::String(value) => format!("t:{value}"),
            Self::Integer(value) => format!("i:{value}"),
            Self::Bool(value) => format!("b:{value}"),
        }
    }
}

/// Strict, proper-list representation produced before semantic lowering.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RawNode {
    /// Scalar datum.
    Atom(Spanned<Atom>),
    /// Proper list. Empty lists are rejected when interpreted as forms.
    List(Spanned<Vec<RawNode>>),
}

impl RawNode {
    /// Node source span.
    #[must_use]
    pub const fn span(&self) -> SourceSpan {
        match self {
            Self::Atom(value) => value.span,
            Self::List(value) => value.span,
        }
    }

    /// Returns this node as a proper list.
    #[must_use]
    pub fn as_list(&self) -> Option<&[RawNode]> {
        match self {
            Self::List(value) => Some(&value.value),
            Self::Atom(_) => None,
        }
    }

    /// Returns this node as an atom.
    #[must_use]
    pub fn as_atom(&self) -> Option<&Atom> {
        match self {
            Self::Atom(value) => Some(&value.value),
            Self::List(_) => None,
        }
    }
}

/// Parsed and header-validated strategy document.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StrategyAst {
    /// Strategy identifier.
    pub id: Spanned<String>,
    /// Exact semantic version.
    pub version: Spanned<String>,
    /// Applicability scope.
    pub scope: Spanned<String>,
    /// Goal text or identifier.
    pub goal: Spanned<String>,
    /// Declarative body sections after header removal.
    pub body: Vec<RawNode>,
    /// Entire strategy range.
    pub span: SourceSpan,
}

/// Parses bounded UTF-8 bytes and validates the strategy envelope.
pub fn parse_strategy_bytes(
    source: &[u8],
    limits: AdmissionLimits,
) -> Result<StrategyAst, Vec<Diagnostic>> {
    let limits = limits.validate().map_err(|error| vec![error])?;
    if source.len() > limits.max_source_bytes {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::SourceTooLarge,
            SourceSpan::ZERO,
            format!(
                "strategy source is {} bytes; limit is {}",
                source.len(),
                limits.max_source_bytes
            ),
        )]);
    }
    let source = std::str::from_utf8(source).map_err(|_| {
        vec![Diagnostic::new(
            DiagnosticCode::InvalidUtf8,
            SourceSpan::ZERO,
            "strategy source must be UTF-8",
        )]
    })?;
    parse_strategy(source, limits)
}

/// Parses a bounded declarative strategy. Source is never evaluated.
pub fn parse_strategy(
    source: &str,
    limits: AdmissionLimits,
) -> Result<StrategyAst, Vec<Diagnostic>> {
    let limits = limits.validate().map_err(|error| vec![error])?;
    if source.len() > limits.max_source_bytes {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::SourceTooLarge,
            SourceSpan::ZERO,
            format!(
                "strategy source is {} bytes; limit is {}",
                source.len(),
                limits.max_source_bytes
            ),
        )]);
    }
    let mut parser = Parser::from_str(source);
    let datum = parser.expect_datum().map_err(|error| {
        vec![Diagnostic::new(
            DiagnosticCode::Parse,
            SourceSpan::ZERO,
            format!("S-expression parse failed: {error}"),
        )]
    })?;
    if parser.expect_end().is_err() {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::TopLevelCount,
            SourceSpan::from(datum.span()),
            "exactly one top-level strategy datum is required",
        )]);
    }

    let mut nodes = 0usize;
    let raw = lower_datum(datum.as_ref(), 1, &mut nodes, limits)?;
    lower_strategy(&raw)
}

fn lower_datum(
    datum: datum::Ref<'_>,
    depth: usize,
    nodes: &mut usize,
    limits: AdmissionLimits,
) -> Result<RawNode, Vec<Diagnostic>> {
    *nodes = nodes.saturating_add(1);
    if *nodes > limits.max_nodes {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::NodeLimit,
            datum.span().into(),
            "strategy datum count exceeded the configured limit",
        )]);
    }
    if depth > limits.max_depth {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::DepthLimit,
            datum.span().into(),
            "strategy semantic nesting exceeded the configured limit",
        )]);
    }
    let span = datum.span().into();
    let atom = match datum.value() {
        Value::Symbol(value) => {
            validate_identifier(value, span)?;
            Some(Atom::Symbol(value.to_string()))
        }
        Value::String(value) => {
            if value.len() > MAX_STRING_BYTES {
                return Err(vec![Diagnostic::new(
                    DiagnosticCode::StringTooLong,
                    span,
                    "inline string exceeds the V1 limit; use an artifact reference",
                )]);
            }
            Some(Atom::String(value.to_string()))
        }
        Value::Number(value) => value
            .as_i64()
            .map(Atom::Integer)
            .ok_or_else(|| {
                vec![Diagnostic::new(
                    DiagnosticCode::UnsupportedDatum,
                    span,
                    "only signed 64-bit integer literals are accepted",
                )]
            })
            .map(Some)?,
        Value::Bool(value) => Some(Atom::Bool(*value)),
        Value::Cons(_) | Value::Null => None,
        Value::Nil | Value::Char(_) | Value::Keyword(_) | Value::Bytes(_) | Value::Vector(_) => {
            return Err(vec![Diagnostic::new(
                DiagnosticCode::UnsupportedDatum,
                span,
                "unsupported S-expression datum in strategy source",
            )]);
        }
    };
    if let Some(atom) = atom {
        return Ok(RawNode::Atom(Spanned { value: atom, span }));
    }

    let mut elements = Vec::new();
    let mut cursor = datum;
    while let Some((head, tail)) = cursor.as_pair() {
        elements.push(lower_datum(head, depth + 1, nodes, limits)?);
        cursor = tail;
    }
    if !matches!(cursor.value(), Value::Null) {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::UnsupportedDatum,
            cursor.span().into(),
            "improper lists are not part of the strategy grammar",
        )]);
    }
    Ok(RawNode::List(Spanned {
        value: elements,
        span,
    }))
}

fn lower_strategy(raw: &RawNode) -> Result<StrategyAst, Vec<Diagnostic>> {
    let span = raw.span();
    let items = raw.as_list().ok_or_else(|| {
        vec![Diagnostic::new(
            DiagnosticCode::ExpectedStrategy,
            span,
            "top-level datum must be a strategy list",
        )]
    })?;
    if symbol_at(items, 0) != Some("strategy") || items.len() < 6 {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::ExpectedStrategy,
            span,
            "expected (strategy IDENT (version ...) (scope ...) (goal ...) body...)",
        )]);
    }
    let id = required_atom_text(&items[1], "strategy identifier")?;
    validate_identifier(&id, items[1].span())?;
    let version = header_value(&items[2], "version")?;
    if !is_exact_semver(&version.value) {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::InvalidHeader,
            version.span,
            "strategy version must be an exact MAJOR.MINOR.PATCH value",
        )]);
    }
    let scope = header_value(&items[3], "scope")?;
    let goal = header_value(&items[4], "goal")?;
    Ok(StrategyAst {
        id: Spanned {
            value: id,
            span: items[1].span(),
        },
        version,
        scope,
        goal,
        body: items[5..].to_vec(),
        span,
    })
}

fn header_value(node: &RawNode, expected: &str) -> Result<Spanned<String>, Vec<Diagnostic>> {
    let items = node
        .as_list()
        .ok_or_else(|| invalid_header(node.span(), expected))?;
    if items.len() != 2 || symbol_at(items, 0) != Some(expected) {
        return Err(invalid_header(node.span(), expected));
    }
    Ok(Spanned {
        value: required_atom_text(&items[1], expected)?,
        span: items[1].span(),
    })
}

fn invalid_header(span: SourceSpan, expected: &str) -> Vec<Diagnostic> {
    vec![Diagnostic::new(
        DiagnosticCode::InvalidHeader,
        span,
        format!("expected ({expected} VALUE) strategy header"),
    )]
}

/// Returns a form head symbol.
#[must_use]
pub fn form_head(node: &RawNode) -> Option<&str> {
    symbol_at(node.as_list()?, 0)
}

/// Returns a scalar value without lossy generic printing.
pub fn required_atom_text(node: &RawNode, context: &str) -> Result<String, Vec<Diagnostic>> {
    let text = match node.as_atom() {
        Some(Atom::Symbol(value) | Atom::String(value)) => value.clone(),
        Some(Atom::Integer(value)) => value.to_string(),
        Some(Atom::Bool(value)) => value.to_string(),
        None => {
            return Err(vec![Diagnostic::new(
                DiagnosticCode::SchemaMismatch,
                node.span(),
                format!("{context} must be a scalar value"),
            )]);
        }
    };
    Ok(text)
}

fn symbol_at(nodes: &[RawNode], index: usize) -> Option<&str> {
    nodes.get(index)?.as_atom()?.as_symbol()
}

fn validate_identifier(value: &str, span: SourceSpan) -> Result<(), Vec<Diagnostic>> {
    if value.len() > MAX_IDENTIFIER_BYTES {
        return Err(vec![Diagnostic::new(
            DiagnosticCode::IdentifierTooLong,
            span,
            "identifier exceeds the V1 byte limit",
        )]);
    }
    Ok(())
}

fn is_exact_semver(value: &str) -> bool {
    let mut parts = value.split('.');
    let valid = (0..3).all(|_| {
        parts.next().is_some_and(|part| {
            !part.is_empty()
                && part.bytes().all(|byte| byte.is_ascii_digit())
                && (part == "0" || !part.starts_with('0'))
        })
    });
    valid && parts.next().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINIMAL: &str = r#"
        (strategy listener-boy
          (version "1.0.0")
          (scope graph:incident)
          (goal "investigate")
          (emit incident-opened))
    "#;

    #[test]
    fn parses_one_source_spanned_strategy_without_evaluation() {
        let strategy = parse_strategy(MINIMAL, AdmissionLimits::default()).unwrap();
        assert_eq!(strategy.id.value, "listener-boy");
        assert_eq!(strategy.version.value, "1.0.0");
        assert_eq!(form_head(&strategy.body[0]), Some("emit"));
        assert!(strategy.span.end.line > strategy.span.start.line);
    }

    #[test]
    fn rejects_multiple_datums_floats_and_improper_lists() {
        let multiple = format!("{MINIMAL} {MINIMAL}");
        assert_eq!(
            parse_strategy(&multiple, AdmissionLimits::default()).unwrap_err()[0].code,
            DiagnosticCode::TopLevelCount,
        );
        let float = MINIMAL.replace("incident-opened", "1.2");
        assert_eq!(
            parse_strategy(&float, AdmissionLimits::default()).unwrap_err()[0].code,
            DiagnosticCode::UnsupportedDatum,
        );
        let improper = MINIMAL.replace("(emit incident-opened)", "(emit . incident-opened)");
        assert_eq!(
            parse_strategy(&improper, AdmissionLimits::default()).unwrap_err()[0].code,
            DiagnosticCode::UnsupportedDatum,
        );
    }

    #[test]
    fn rejects_source_and_semantic_depth_bombs_before_admission() {
        let oversized = vec![b'a'; DEFAULT_MAX_SOURCE_BYTES + 1];
        assert_eq!(
            parse_strategy_bytes(&oversized, AdmissionLimits::default()).unwrap_err()[0].code,
            DiagnosticCode::SourceTooLarge,
        );
        let mut nested = String::new();
        nested.push_str("(strategy s (version \"1.0.0\") (scope x) (goal x) ");
        nested.push_str(&"(sequence ".repeat(DEFAULT_MAX_DEPTH));
        nested.push_str("(emit x)");
        nested.push_str(&")".repeat(DEFAULT_MAX_DEPTH + 1));
        assert_eq!(
            parse_strategy(&nested, AdmissionLimits::default()).unwrap_err()[0].code,
            DiagnosticCode::DepthLimit,
        );
    }
}
