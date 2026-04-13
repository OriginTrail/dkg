# Smoke Test: PDF Import, Promote, Publish, Dedup

This smoke test exercises the CLI flow for:

1. importing a PDF into an assertion
2. checking extraction status
3. promoting the assertion into shared memory
4. publishing shared memory to the context graph
5. importing a second PDF with overlapping RDF
6. promoting and publishing again
7. verifying the overlapping facts are deduplicated rather than duplicated

## Preconditions

- The daemon is running.
- The node can publish for the target context graph.
- `markitdown` is installed or available in `PATH` so PDF extraction works.
- You have two PDFs whose extracted Markdown produces overlapping facts.

Recommended fixture shape:

- `report-a.pdf` extracts to facts including:
  - a root entity (auto-assigned by the extractor based on document content)
  - `schema:name "Acme"`
  - `schema:industry "Logistics"`
  - `schema:url <https://acme.example>`
- `report-b.pdf` extracts to facts including at least one overlapping triple:
  - `schema:name "Acme"`
  - `schema:industry "Logistics"`
  - plus one new IRI-valued fact such as `schema:url <https://acme.example/contact>`

The important part is that both documents resolve at least one identical RDF triple after extraction. Note: the extractor assigns root entities automatically (typically derived from the assertion URI), so do not assume a hand-picked subject like `urn:company:acme` will be preserved.

## Suggested Test IDs

```bash
export CG_ID="smoke-pdf-dedup"
export ASSERTION_A="reportA"
export ASSERTION_B="reportB"
export PDF_A="$PWD/docs/testing/test-files/report-a.pdf"
export PDF_B="$PWD/docs/testing/test-files/report-b.pdf"
```

Create the context graph if needed:

```bash
dkg context-graph create "$CG_ID" --name "$CG_ID"
```

If that fails with an error mentioning `participantIdentityIds` and
`requiredSignatures`, your running daemon is older than the CLI/source in this
repo. Restart the daemon from the current build, or pick an existing context
graph from:

```bash
dkg context-graph list
```

## Step 1: Import the First PDF

```bash
dkg assertion import-file "$ASSERTION_A" \
  --file "$PDF_A" \
  --context-graph "$CG_ID"
```

Expected:

- output includes `Assertion import complete:`
- output includes `Detected content type: application/pdf`
- extraction status is `completed`

Double-check status:

```bash
dkg assertion extraction-status "$ASSERTION_A" --context-graph "$CG_ID"
```

## Step 2: Promote the First Assertion to Shared Memory

```bash
dkg assertion promote "$ASSERTION_A" --context-graph "$CG_ID"
```

Expected:

- output includes `Assertion promoted to shared memory:`
- output reports a non-zero triple count

## Step 3: Publish Shared Memory

```bash
dkg shared-memory publish "$CG_ID"
```

Expected:

- publish succeeds
- output includes a `Status:` line
- output includes a `KC ID:` line

## Step 4: Record the Baseline Result Count

Run a query for the shared root entity or the overlapping predicate/object pair.

Example query for the overlapping triple (uses a variable for the subject since root entity URIs are extractor-assigned):

```bash
dkg query "$CG_ID" --sparql '
SELECT ?s ?g WHERE {
  GRAPH ?g {
    ?s <http://schema.org/industry> "Logistics" .
  }
}
'
```

If you want a strict duplicate count for that triple across graphs:

```bash
dkg query "$CG_ID" --sparql '
SELECT (COUNT(DISTINCT ?g) AS ?graphs) WHERE {
  GRAPH ?g {
    ?s <http://schema.org/industry> "Logistics" .
  }
}
'
```

Record the row count after the first publish.

## Step 5: Import the Second PDF with Overlapping RDF

```bash
dkg assertion import-file "$ASSERTION_B" \
  --file "$PDF_B" \
  --context-graph "$CG_ID"
```

Then confirm extraction:

```bash
dkg assertion extraction-status "$ASSERTION_B" --context-graph "$CG_ID"
```

Expected:

- extraction status is `completed`
- the second document contributes at least one overlapping triple and at least one new triple

## Step 6: Promote the Second Assertion to Shared Memory

```bash
dkg assertion promote "$ASSERTION_B" --context-graph "$CG_ID"
```

## Step 7: Publish Again

```bash
dkg shared-memory publish "$CG_ID"
```

Expected:

- publish succeeds again
- no duplicate-copy failure occurs

## Step 8: Verify Dedup

Re-run the duplicate check query:

```bash
dkg query "$CG_ID" --sparql '
SELECT ?g WHERE {
  GRAPH ?g {
    <urn:company:acme> <http://schema.org/industry> "Logistics" .
  }
}
'
```

Pass condition:

- the overlapping triple is still present
- it does not appear more times than expected after the second publish
- the new non-overlapping triple from `report-b.pdf` is present

Recommended follow-up query for the new fact (note: URL values are extracted as IRIs, not string literals):

```bash
dkg query "$CG_ID" --sparql '
SELECT ?s ?g WHERE {
  GRAPH ?g {
    ?s <http://schema.org/url> <https://acme.example/contact> .
  }
}
'
```

## Expected Outcome Summary

- first PDF imports successfully
- first assertion promotes successfully
- first publish succeeds
- second PDF imports successfully
- second assertion promotes successfully
- second publish succeeds
- overlapping RDF is not duplicated after the second publish
- new RDF from the second PDF is added successfully
