import { vi, type Mock } from 'vitest'
import { NeonDbError } from '@neondatabase/serverless'

/**
 * Shared raw-SQL mock helper for `lib/db/client.ts`'s tagged-template `sql`
 * query function (#332).
 *
 * This replaces the per-file hand-rolled SQL mocks that dispatched on loose
 * substrings of the rebuilt query text (e.g. `query.includes('update')`,
 * `query.includes('count')`). That style produced real false results during
 * #299:
 *
 * - `no_show_count` contains `count`, so a COUNT-query handler matched a
 *   plain data SELECT.
 * - `updated_at` contains `update`, so an `!includes('update')` guard was
 *   always false.
 * - A weakened WHERE clause (3 conditions collapsed to 1) still matched the
 *   handler written for the 3-condition query, silently reading a
 *   non-existent bound value and returning `[]` — the mock failed *stricter*
 *   than real SQL, so a vulnerable id-only WHERE looked safe.
 * - A SELECT handler matched DELETE statements because both mentioned
 *   `from profiles`, so a delete never executed in the mock.
 *
 * The fixes this helper encodes as structural guarantees, not per-file
 * discipline:
 *
 * 1. Every handler is anchored on the statement's SQL verb — derived only
 *    from the first token of the statement (`parseStatement`) — before any
 *    other matching runs. A handler registered for `update` is never even
 *    considered for a `select`, regardless of what column/table names appear.
 * 2. Handlers apply only the WHERE conditions the statement actually
 *    carries (via `whereHasColumn`, checked against the extracted WHERE
 *    clause only — never the whole query text), so weakening a WHERE clause
 *    changes matching/behaviour instead of being silently absorbed.
 * 3. There is no silent `[]` fallback: a statement that matches no
 *    registered handler throws, naming the verb and text, so a
 *    mis-anchored handler or an unexpectedly-shaped query fails loudly
 *    instead of quietly returning empty rows.
 * 4. Column/table checks are word-boundary anchored (`hasWord`), not
 *    substring checks, so `no_show_count` never satisfies a `count` check
 *    and `updated_at` never satisfies an `update` check.
 *
 * ## `.transaction()` support (#346 P1 follow-up)
 *
 * Neon's non-interactive HTTP transaction (`sql.transaction([...queries])`)
 * batches several already-invoked `sql\`...\`` calls into one atomic
 * round-trip. Each element of that array is a promise from a tagged-template
 * call that — in this mock — already dispatched through the handler-matching
 * system above and already started settling by the time it's placed in the
 * array (there's no real network round-trip to defer it). So a mock
 * transaction can't roll anything back; the only thing worth modelling is
 * the two guarantees callers actually depend on:
 *
 * 1. The DELETE and INSERT must travel together as a single
 *    `sql.transaction([...])` call, not as two independent `sql` calls —
 *    `transaction` below is its own `vi.fn`, both exposed as
 *    `SqlMock.transaction` (for assertions) and attached as `sql.transaction`
 *    (because that's the property production code actually calls).
 * 2. A rejection from any batched query must propagate as a rejection of
 *    the whole `sql.transaction(...)` call — implemented as a plain
 *    `Promise.all`, which already has that exact semantic.
 *
 * `neonDbError()` below is a companion helper for handlers that need to
 * simulate a specific Postgres error code (e.g. `23505` unique_violation)
 * rather than a generic `Error` — it constructs a *real* `NeonDbError`
 * instance (not a plain object), which matters because service code guards
 * on `error instanceof NeonDbError` before trusting `.code`.
 */

export type SqlVerb = 'select' | 'insert' | 'update' | 'delete'

export interface ParsedStatement {
  /** Full statement text: lowercased, whitespace-collapsed, with `$1`/`$2`/… substituted for each interpolated value in order. */
  text: string
  /** SQL verb anchored to the first token of the statement, or to the verb inside a leading `WITH ... AS ( ... )` CTE. `'unknown'` if neither is select/insert/update/delete. */
  verb: SqlVerb | 'unknown'
  /** Bound values, in the order the tagged template interpolated them. */
  values: unknown[]
  /** Table name resolved from the clause immediately following the verb (FROM / INSERT INTO / UPDATE / DELETE FROM). Null if not resolvable. */
  table: string | null
  /** Raw WHERE clause text (lowercased), excluding the `where` keyword itself and any trailing RETURNING/ORDER BY/GROUP BY/LIMIT clause. Null if the statement has no WHERE clause. */
  whereClause: string | null
  /** True if the statement contains a RETURNING clause. */
  returning: boolean
  /**
   * True only for a `select` whose column list (the text between `select`
   * and `from`) begins with `count(`. Anchored to that position — never a
   * loose `.includes('count')` — so a plain column named `no_show_count`
   * can never satisfy this.
   */
  isCountSelect: boolean
  /**
   * True only for a `select` whose column list (the text between `select`
   * and `from`) begins with `now(`. Anchored to that position — never a
   * loose `.includes('now()')` — so a plain column like `created_at` or
   * ORDER BY clause containing `now()` can never satisfy this.
   */
  isNowSelect: boolean
  /** Exact, normalized SELECT projection (between SELECT and FROM), if this is a SELECT with FROM. */
  selectColumns: string | null
  /** Exact, normalized ORDER BY expression, excluding trailing LIMIT/OFFSET. */
  orderBy: string | null
  /** True only when the statement has a LIMIT clause with a bound value. */
  hasLimit: boolean
  /** True only when the statement has an OFFSET clause with a bound value. */
  hasOffset: boolean
}

const VERB_RE = /^\s*(select|insert|update|delete)\b/i

/**
 * Marker symbol identifying a value produced by the mock's `sql.unsafe()` —
 * mirrors the real Neon driver's `sql.unsafe()`, which inlines its argument
 * as literal query text instead of binding it as a parameter. Recognizing
 * this here (rather than treating it like any other interpolated value) is
 * what lets `RESERVATION_COLUMNS`-style `sql.unsafe(...)` column lists
 * render as literal text in the rebuilt statement, so existing
 * column-list/handler matching keeps working unchanged (#348 code-review
 * fixes reintroduced a shared column list injected via `sql.unsafe`).
 */
const RAW_SQL_MARKER = Symbol('sql-mock-raw-fragment')

interface RawSqlFragment {
  [RAW_SQL_MARKER]: true
  text: string
}

function isRawSqlFragment(value: unknown): value is RawSqlFragment {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[RAW_SQL_MARKER] === true
}

/** Wraps a string as a raw/unsafe SQL fragment — the mock counterpart to the real driver's `sql.unsafe()`. */
export function unsafeSqlFragment(text: string): RawSqlFragment {
  return { [RAW_SQL_MARKER]: true, text }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Walks every top-level CTE in a `WITH name1 AS (...), name2 AS (...), ...`
 * prefix (text must already start with `with`) and returns each one's inner
 * verb, in order. Tracks paren depth while scanning each CTE body so a
 * nested subquery's own `AS (SELECT ...)` never gets mistaken for the start
 * of the next top-level CTE. Returns `[]` if `text` doesn't start with `with`
 * or no CTE could be parsed.
 */
function extractLeadingCteVerbs(text: string): SqlVerb[] {
  if (!/^with\s/i.test(text)) return []

  const verbs: SqlVerb[] = []
  let pos = 4 // length of "with"
  for (;;) {
    const cteHeader = /^\s*[a-z_][a-z0-9_]*\s+as\s*\(/i.exec(text.slice(pos))
    if (!cteHeader) break
    const bodyStart = pos + cteHeader[0].length // just after this CTE's '('

    const innerVerb = /^\s*(select|insert|update|delete)\b/i.exec(text.slice(bodyStart))
    if (innerVerb) verbs.push(innerVerb[1].toLowerCase() as SqlVerb)

    let depth = 1
    let i = bodyStart
    while (depth > 0 && i < text.length) {
      if (text[i] === '(') depth += 1
      else if (text[i] === ')') depth -= 1
      i += 1
    }
    if (depth !== 0) break // unbalanced parens — malformed input, stop rather than loop forever
    pos = i // just after this CTE's matching ')'

    const nextComma = /^\s*,/.exec(text.slice(pos))
    if (!nextComma) break
    pos += nextComma[0].length
  }
  return verbs
}

/**
 * Rebuilds the query text from a tagged-template call (or a plain string,
 * for callers that invoke `sql` directly instead of as a tagged template)
 * and parses out the verb, table, WHERE clause and RETURNING flag. This is
 * the single place statement shape is derived from — handlers must always
 * consume the parsed fields below rather than re-deriving shape with ad hoc
 * `.includes()` checks against raw text.
 *
 * Values produced by `sql.unsafe()` are inlined as literal text (not
 * numbered as bound parameters), matching the real driver's behaviour, and
 * are excluded from the returned `values` array — only genuinely bound
 * parameters are numbered/collected.
 */
export function parseStatement(
  strings: TemplateStringsArray | string,
  values: unknown[],
): ParsedStatement {
  let boundValues: unknown[] = values
  const raw =
    typeof strings === 'string'
      ? strings
      : (() => {
          let result = ''
          let paramIndex = 0
          const collected: unknown[] = []
          strings.forEach((part, i) => {
            result += part
            if (i < values.length) {
              const value = values[i]
              if (isRawSqlFragment(value)) {
                result += value.text
              } else {
                paramIndex += 1
                result += `$${paramIndex}`
                collected.push(value)
              }
            }
          })
          boundValues = collected
          return result
        })()

  const text = collapseWhitespace(raw.toLowerCase())

  const verbMatch = VERB_RE.exec(text)
  let verb = (verbMatch?.[1] as SqlVerb | undefined) ?? 'unknown'

  // CTE support (#301 follow-up): `WITH <name> AS ( INSERT/UPDATE/DELETE/SELECT
  // ... ) SELECT ...` — e.g. `WITH ins AS (INSERT INTO saved_games (...)
  // RETURNING *) SELECT ... FROM ins sg LEFT JOIN tables ...`, used so a
  // RETURNING clause can be re-selected joined against other tables. The
  // outer statement literally starts with `with`, which VERB_RE never
  // anchors on, so without this the mock would throw "could not anchor a SQL
  // verb" for every CTE-wrapped statement. Anchoring to the verb *inside* the
  // CTE parens instead treats the statement as that inner verb for handler
  // matching (table/values extraction below already works unmodified against
  // the CTE body since those regexes aren't start-anchored).
  //
  // Multi-CTE support (#334 follow-up): a statement can chain several named
  // CTEs before the data-modifying one — e.g. `WITH input AS (SELECT ...),
  // conflict AS (SELECT ...), ins AS (INSERT ... RETURNING *) SELECT ... FROM
  // ins ...` (createSavedGameForSession's advisory-lock-guarded conflict
  // re-check). The single-CTE regex above only ever looks at the FIRST named
  // CTE, so it would anchor to `input`'s inner `select` and never find the
  // real `insert`. `extractLeadingCteVerbs` below walks every top-level CTE
  // (tracking paren depth so it isn't fooled by nested subqueries) and this
  // picks the first data-modifying one, falling back to the first CTE's verb
  // if none of them modify data.
  if (verb === 'unknown') {
    const cteVerbs = extractLeadingCteVerbs(text)
    const modifying = cteVerbs.find((v) => v === 'insert' || v === 'update' || v === 'delete')
    verb = modifying ?? cteVerbs[0] ?? 'unknown'
  }

  let table: string | null = null
  if (verb === 'select' || verb === 'delete') {
    table = /\bfrom\s+([a-z_][a-z0-9_]*)/i.exec(text)?.[1] ?? null
  } else if (verb === 'insert') {
    table = /\binsert\s+into\s+([a-z_][a-z0-9_]*)/i.exec(text)?.[1] ?? null
  } else if (verb === 'update') {
    table = /^\s*update\s+([a-z_][a-z0-9_]*)/i.exec(text)?.[1] ?? null
  }

  const whereMatch =
    /\bwhere\s+(.+?)(?:\s+returning\b|\s+order\s+by\b|\s+group\s+by\b|\s+limit\b|$)/i.exec(
      text,
    )
  const whereClause = whereMatch?.[1]?.trim() ?? null

  const returning = /\breturning\b/i.test(text)

  const selectColumns = verb === 'select'
    ? /^select\s+(.*?)\s+from\b/i.exec(text)?.[1]?.trim() ?? null
    : null
  const orderBy = /\border\s+by\s+(.+?)(?=\s+limit\b|\s+offset\b|$)/i.exec(text)?.[1]?.trim() ?? null
  const hasLimit = /\blimit\s+\$\d+\b/i.test(text)
  const hasOffset = /\boffset\s+\$\d+\b/i.test(text)

  let isCountSelect = false
  let isNowSelect = false
  if (verb === 'select') {
    const projection = selectColumns ?? /^select\s+(.*)$/i.exec(text)?.[1] ?? ''
    isCountSelect = /^count\s*\(/i.test(projection.trim())
    isNowSelect = /^now\s*\(/i.test(projection.trim())
  }

  return { text, verb, values: boundValues, table, whereClause, returning, isCountSelect, isNowSelect, selectColumns, orderBy, hasLimit, hasOffset }
}

/**
 * Word-boundary-anchored substring check. Never a loose `.includes()` —
 * this is what prevents `no_show_count` from satisfying a `count` check, or
 * `updated_at` from satisfying an `update` check.
 */
export function hasWord(haystack: string | null | undefined, word: string): boolean {
  if (!haystack) return false
  return new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i').test(haystack)
}

/**
 * Whether the statement's WHERE clause references the given column,
 * word-boundary anchored. Checked only against the extracted WHERE text
 * (never the SET clause, the column list, or the full query), so a column
 * that appears elsewhere in the statement but not in the WHERE clause does
 * not produce a false match.
 */
export function whereHasColumn(stmt: ParsedStatement, column: string): boolean {
  return hasWord(stmt.whereClause, column)
}

/**
 * Whether the statement's non-WHERE portion (the SET clause for UPDATE, the
 * column list for SELECT/INSERT) references the given column, word-boundary
 * anchored.
 */
export function hasColumn(stmt: ParsedStatement, column: string): boolean {
  const whereIndex = stmt.whereClause ? stmt.text.indexOf(stmt.whereClause) : -1
  const beforeWhere = whereIndex >= 0 ? stmt.text.slice(0, whereIndex) : stmt.text
  return hasWord(beforeWhere, column)
}

/**
 * Number of top-level conditions in the WHERE clause (0 if there is no WHERE
 * clause), separated by AND or OR. Lets a handler assert that a statement
 * carries as many — or as few — conditions as it expects, instead of
 * assuming a fixed shape regardless of what the statement actually contains.
 *
 * Counts both AND-joined and OR-joined conditions. For example:
 * - "A = $1" → 1 condition
 * - "A = $1 AND B = $2" → 2 conditions
 * - "A ILIKE $1 OR B ILIKE $2 OR C ILIKE $3" → 3 conditions
 *
 * **LIMITATION — Parenthesis Grouping Not Supported:**
 * This function does NOT handle parenthesized/grouped conditions correctly.
 * A WHERE clause like "(A = $1 OR B = $2) AND C = $3" will be incorrectly
 * counted as 3 conditions instead of the semantically correct 2 top-level conditions.
 * If future SQL migrations use WHERE grouping (e.g., for complex authorization rules),
 * this function must be updated to track parenthesis depth, or handlers must use
 * explicit column checks (e.g., whereHasColumn() + whereColumnHasOperator()) instead
 * of relying on whereConditionCount() for semantic accuracy.
 *
 * This ensures that weakening a WHERE clause (fewer actual conditions)
 * produces an observably different result, preventing silent mismatches
 * where a handler written for 3 conditions accidentally matches a 1-condition
 * query and reads non-existent bound values.
 */
export function whereConditionCount(stmt: ParsedStatement): number {
  if (!stmt.whereClause) return 0
  return stmt.whereClause.split(/\b(?:and|or)\b/i).filter((part) => part.trim().length > 0).length
}

/**
 * Whether a specific column in the WHERE clause uses a specific operator,
 * word-boundary anchored. Detects the exact operator (=, ILIKE, <>, etc)
 * on a given column, not substring-based. This distinguishes:
 * - `member_number = $1` (exact match)
 * - `member_number ILIKE $1` (pattern match)
 * and prevents loose text-scanning defects like #299's `updated_at` vs `update`.
 */
export function whereColumnHasOperator(
  stmt: ParsedStatement,
  column: string,
  operator: string,
): boolean {
  if (!stmt.whereClause) return false
  const escapedColumn = escapeRegExp(column)
  const escapedOp = escapeRegExp(operator)
  const pattern = new RegExp(
    `\\b${escapedColumn}\\b\\s*${escapedOp}\\s`,
    'i',
  )
  return pattern.test(stmt.whereClause)
}

/**
 * Whether a specific column uses an IS NULL or IS NOT NULL predicate in the WHERE clause.
 * Specialized version for null checks, since those end with a word boundary, not a space.
 * Examples: `WHERE used_at IS NULL` or `WHERE expires_at IS NOT NULL`.
 */
export function whereColumnHasNullCheck(
  stmt: ParsedStatement,
  column: string,
  nullCheck: 'IS NULL' | 'IS NOT NULL',
): boolean {
  if (!stmt.whereClause) return false
  const escapedColumn = escapeRegExp(column)
  const escapedCheck = escapeRegExp(nullCheck)
  // Match: word boundary, column name, word boundary, whitespace, null check, word boundary
  // This avoids matching "used_at_backup IS NULL" for column "used_at"
  const pattern = new RegExp(
    `\\b${escapedColumn}\\b\\s+${escapedCheck}\\b`,
    'i',
  )
  return pattern.test(stmt.whereClause)
}

/**
 * Matches a simple WHERE clause exactly: every condition must be one of the
 * requested `column operator $N` predicates, joined with the given connector.
 * This intentionally rejects extra predicates and duplicate/missing columns.
 */
export function whereHasExactBoundConditions(
  stmt: ParsedStatement,
  conditions: Array<{ column: string; operator: string }>,
  connector: 'and' | 'or',
): boolean {
  if (!stmt.whereClause) return false
  const parts = stmt.whereClause.split(new RegExp(`\\s+${connector}\\s+`, 'i'))
  if (parts.length !== conditions.length) return false

  const remaining = [...conditions]
  for (const part of parts) {
    const match = /^\s*([a-z_][a-z0-9_]*)\s+(=|ilike|<>|>|<|>=|<=)\s+\$(\d+)\s*$/i.exec(part)
    if (!match) return false
    const index = remaining.findIndex(
      (condition) => condition.column === match[1].toLowerCase() && condition.operator.toLowerCase() === match[2].toLowerCase(),
    )
    if (index === -1) return false
    remaining.splice(index, 1)
  }
  return remaining.length === 0
}

/** Exact normalized SELECT projection comparison. */
export function hasExactSelectColumns(stmt: ParsedStatement, columns: string): boolean {
  return stmt.selectColumns === collapseWhitespace(columns.toLowerCase())
}

/** Exact normalized ORDER BY comparison. */
export function hasExactOrderBy(stmt: ParsedStatement, expression: string): boolean {
  return stmt.orderBy === collapseWhitespace(expression.toLowerCase())
}

/** Case-insensitive `%term%` ILIKE pattern match against a nullable column value. */
export function matchesIlikePattern(
  text: string | null | undefined,
  pattern: string | null | undefined,
): boolean {
  if (!pattern || !text) return false
  const term = pattern.replace(/%/g, '').toLowerCase()
  return text.toLowerCase().includes(term)
}

export interface SqlMockHandler {
  /** Human-readable name surfaced in "no handler matched" errors — keep it specific enough to locate the failing handler quickly. */
  name: string
  /**
   * Anchored verb this handler applies to. Handlers are only ever
   * considered for statements whose parsed verb equals this — a handler is
   * never reached by table/column shape alone.
   */
  verb: SqlVerb
  /** Match predicate, run only after the verb anchor already matched. Use `whereHasColumn`/`hasColumn`/`stmt.table`/`stmt.returning`/`stmt.isCountSelect` rather than re-deriving shape from `stmt.text`. */
  match: (stmt: ParsedStatement) => boolean
  /** Produces the mocked result rows for a matched statement. */
  respond: (stmt: ParsedStatement) => unknown | Promise<unknown>
}

export interface SqlMock {
  /**
   * Pass this directly as the `sql` export: `vi.mock('@/lib/db/client', () =>
   * ({ sql: mock.sql }))`. Also carries `.transaction` (the same mock as
   * `SqlMock.transaction` below, since production code calls
   * `sql.transaction([...])`) and `.unsafe` (mirrors the real driver's
   * `sql.unsafe()`).
   */
  sql: Mock & { transaction: Mock; unsafe: typeof unsafeSqlFragment }
  /**
   * The same mock as `sql.transaction`, exposed at the top level so tests
   * can assert on it directly (call count, batched array contents) without
   * reaching through `sql.transaction`. Defaults to `Promise.all(queries)` —
   * runs every already-dispatched batched query and rejects the whole call
   * if any of them rejects.
   */
  transaction: Mock
  /** Registers a handler, checked after every previously-added handler (first match, in registration order, wins). */
  addHandler(handler: SqlMockHandler): SqlMock
  /** Registers a handler that is checked BEFORE all currently-registered handlers — for test-specific overrides layered on top of a shared base setup. */
  prependHandler(handler: SqlMockHandler): SqlMock
  /** Removes all registered handlers. Does not touch `sql`'s call history. */
  clearHandlers(): void
  /** Clears handlers and resets `sql`'s and `sql.transaction`'s call history/implementation. Call from `beforeEach` for a clean slate between tests. */
  reset(): void
}

/**
 * Builds a real `NeonDbError` instance carrying the given Postgres error
 * code (and, optionally, the violated constraint name), for a handler's
 * `respond` to `throw` when a test needs to simulate a specific SQL error
 * condition (e.g. `23505` unique_violation) rather than a generic `Error`.
 * Real class, not a plain `{ code }` object, because service code checks
 * `error instanceof NeonDbError` before trusting `.code`.
 *
 * `constraint` mirrors the real `NeonDbError` class shape (a flat top-level
 * `constraint: string | undefined` property, alongside `.code`) and defaults
 * to `undefined` so existing callers that don't need to simulate a specific
 * constraint name keep working unchanged.
 */
export function neonDbError(
  code: string,
  message = 'simulated Postgres error',
  constraint?: string,
): NeonDbError {
  const error = new NeonDbError(message)
  error.code = code
  error.constraint = constraint
  return error
}

/**
 * Creates a shared SQL mock instance. One instance per test file (or per
 * `describe` block, if isolation between suites is needed) — register base
 * handlers once (e.g. in `beforeEach`), and layer test-specific overrides
 * with `prependHandler` for individual tests that need different behaviour.
 *
 * Unmatched statements throw instead of returning `[]`, so a handler that's
 * missing, mis-anchored, or bypassed by a weakened WHERE clause surfaces as
 * a loud test failure naming the verb and statement text — never a silent
 * empty result that a test might accidentally treat as "not found".
 */
export function createSqlMock(): SqlMock {
  let handlers: SqlMockHandler[] = []

  const sql = vi.fn(async (strings: TemplateStringsArray | string, ...values: unknown[]) => {
    const stmt = parseStatement(strings, values)

    if (stmt.verb === 'unknown') {
      throw new Error(
        `sql-mock: could not anchor a SQL verb (select/insert/update/delete) from statement: "${stmt.text}"`,
      )
    }

    for (const handler of handlers) {
      if (handler.verb !== stmt.verb) continue
      if (handler.match(stmt)) {
        return handler.respond(stmt)
      }
    }

    throw new Error(
      `sql-mock: no handler matched ${stmt.verb.toUpperCase()} statement (no silent [] fallback) — ` +
        `"${stmt.text}" values=${JSON.stringify(stmt.values)}`,
    )
  }) as Mock & { unsafe: typeof unsafeSqlFragment }

  // Mirrors the real Neon driver's `sql.unsafe()` — used by callers (e.g.
  // reservations-service's shared `RESERVATION_COLUMNS`) to inject a raw
  // literal SQL fragment. See `parseStatement`/`isRawSqlFragment` for how
  // this is recognized and inlined instead of being treated as a bound
  // parameter.
  sql.unsafe = unsafeSqlFragment

  // Neon's non-interactive HTTP transaction: batches already-dispatched
  // tagged-template promises into one call. `Promise.all` already has the
  // exact semantics needed — resolve to all results, reject the whole call
  // if any one of them rejects — so there is nothing bespoke to implement.
  const transaction = vi.fn(async (queries: unknown[]) => Promise.all(queries as Array<Promise<unknown>>))
  ;(sql as unknown as { transaction: Mock }).transaction = transaction

  const api: SqlMock = {
    sql: sql as Mock & { transaction: Mock; unsafe: typeof unsafeSqlFragment },
    transaction,
    addHandler(handler) {
      handlers.push(handler)
      return api
    },
    prependHandler(handler) {
      handlers.unshift(handler)
      return api
    },
    clearHandlers() {
      handlers = []
    },
    reset() {
      handlers = []
      sql.mockClear()
      transaction.mockClear()
    },
  }

  return api
}
