/**
 * An unquoted YAML timestamp, and the text it was written as.
 *
 * js-yaml turns an unquoted timestamp into a `Date`, which loses what the
 * producer wrote: `2026-06-15` and `2026-06-15T00:00:00Z` become the same
 * instant, an offset-less `2026-12-31T00:00:00` silently becomes UTC, and an
 * impossible `2026-02-30` rolls over to March. The OKF document schema
 * (`document.ts`) keeps an impossible value as the string it was, and reads
 * every valid one as a `YamlTimestamp`, so a timestamp is read the same way
 * whether or not it was quoted. No dependencies, so any module can read it.
 */

/**
 * A valid unquoted YAML timestamp: a `Date` holding the instant js-yaml reads
 * (so date arithmetic and `instanceof Date` checks are unchanged) that
 * declares the text it was written as. That text is how it is written
 * everywhere: as YAML (the export schema), as JSON (`toJSON`, inside a value
 * kept verbatim as `rdf:JSON`) and as an RDF lexical (`dateTimeLexical`). A
 * plain `Date` made from one (`new Date(timestamp)`) is the instant alone.
 * The text is a private field, so the instance has the own keys a plain
 * `Date` has (none).
 */
export class YamlTimestamp extends Date {
  readonly #lexical: string;

  /** `instant` is the time js-yaml reads `lexical` as. */
  constructor(lexical: string, instant: Date) {
    super(instant.getTime());
    this.#lexical = lexical;
  }

  /** The text the timestamp was written as. */
  get lexical(): string {
    return this.#lexical;
  }

  /** The text it was written as, not the UTC instant: a date stays a date inside JSON. */
  override toJSON(): string {
    return this.#lexical;
  }
}

/** The YAML text `value` was parsed from, when it is a timestamp the OKF schema parsed. */
export function yamlLexicalOf(value: unknown): string | undefined {
  return value instanceof YamlTimestamp ? value.lexical : undefined;
}
