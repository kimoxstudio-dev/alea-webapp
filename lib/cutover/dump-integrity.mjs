/**
 * lib/cutover/dump-integrity.mjs — F2 cutover prep/tooling (KIM-419).
 *
 * Pure, dependency-free logic backing step (a) of
 * Linear KIM-420: sanity-checking the *shape* of a plain-text
 * `pg_dump` output (table coverage + row counts) before it is restored into
 * the target Postgres.
 *
 * This module never shells out to `pg_dump`/`pg_restore` and never touches
 * a real database connection — it only parses dump text that is either
 * handed to it (e.g. piped from a real `pg_dump --format=plain` run,
 * outside of this module's concern) or, for rehearsal, synthetic fixture
 * text built in-memory by scripts/cutover-rehearsal.sh. Keeping the parser
 * dependency-free means the rehearsal never needs a real Postgres or a new
 * package to exercise the mechanical "does the dump look complete" check.
 */

/**
 * Parses a plain-text SQL dump for `COPY <table> (...) FROM stdin;` blocks
 * and counts the data rows between the header and the terminating `\.`
 * line. This mirrors the section of a `pg_dump --format=plain` file that
 * matters for a coverage check — it intentionally ignores everything else
 * (CREATE TABLE, indexes, sequences, etc.) since row-count-per-table is
 * the cheapest strong signal that a restore will be structurally complete.
 *
 * @param {string} dumpText
 * @returns {Map<string, number>} table name -> row count found in its COPY block
 */
export function parseDumpTables(dumpText) {
  const lines = dumpText.split('\n')
  const tableRowCounts = new Map()

  let currentTable = null
  let currentRowCount = 0

  const copyHeaderRe = /^COPY\s+(?:public\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/

  for (const line of lines) {
    if (currentTable === null) {
      const match = copyHeaderRe.exec(line)
      if (match) {
        currentTable = match[1]
        currentRowCount = 0
      }
      continue
    }

    if (line === '\\.') {
      tableRowCounts.set(currentTable, currentRowCount)
      currentTable = null
      currentRowCount = 0
      continue
    }

    currentRowCount += 1
  }

  return tableRowCounts
}

/**
 * Validates that a parsed dump covers every table in `expectedTables`.
 * Extra tables beyond the expected list are reported but do not fail the
 * check (a superset is fine — schema drift ahead of the manifest is a
 * separate, non-blocking signal for the operator to notice).
 *
 * @param {string} dumpText
 * @param {string[]} expectedTables
 * @returns {{
 *   ok: boolean,
 *   missingTables: string[],
 *   extraTables: string[],
 *   tableRowCounts: Map<string, number>,
 * }}
 */
export function validateDump(dumpText, expectedTables) {
  const tableRowCounts = parseDumpTables(dumpText)
  const foundTables = new Set(tableRowCounts.keys())

  const missingTables = expectedTables.filter((t) => !foundTables.has(t))
  const extraTables = [...foundTables].filter((t) => !expectedTables.includes(t))

  return {
    ok: missingTables.length === 0,
    missingTables,
    extraTables,
    tableRowCounts,
  }
}
