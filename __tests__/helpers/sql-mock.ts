import { vi, type Mock } from 'vitest'

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
 */

export type SqlVerb = 'select' | 'insert' | 'update' | 'delete'

export interface ParsedStatement {
  /** Full statement text: lowercased, whitespace-collapsed, with `$1`/`$2`/… substituted for each interpolated value in order. */
  text: string
  /** SQL verb anchored to the first token of the statement. `'unknown'` if the statement doesn't start with select/insert/update/delete. */
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
}

const VERB_RE = /^\s*(select|insert|update|delete)\b/i

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Rebuilds the query text from a tagged-template call (or a plain string,
 * for callers that invoke `sql` directly instead of as a tagged template)
 * and parses out the verb, table, WHERE clause and RETURNING flag. This is
 * the single place statement shape is derived from — handlers must always
 * consume the parsed fields below rather than re-deriving shape with ad hoc
 * `.includes()` checks against raw text.
 */
export function parseStatement(
  strings: TemplateStringsArray | string,
  values: unknown[],
): ParsedStatement {
  const raw =
    typeof strings === 'string'
      ? strings
      : strings.reduce(
          (acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''),
          '',
        )

  const text = collapseWhitespace(raw.toLowerCase())

  const verbMatch = VERB_RE.exec(text)
  const verb = (verbMatch?.[1] as SqlVerb | undefined) ?? 'unknown'

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

  let isCountSelect = false
  let isNowSelect = false
  if (verb === 'select') {
    const selectColumns =
      /^select\s+(.*?)\s+from\b/i.exec(text)?.[1] ??
      /^select\s+(.*)$/i.exec(text)?.[1] ??
      ''
    isCountSelect = /^count\s*\(/i.test(selectColumns.trim())
    isNowSelect = /^now\s*\(/i.test(selectColumns.trim())
  }

  return { text, verb, values, table, whereClause, returning, isCountSelect, isNowSelect }
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
  /** Pass this directly as the `sql` export: `vi.mock('@/lib/db/client', () => ({ sql: mock.sql }))`. */
  sql: Mock
  /** Registers a handler, checked after every previously-added handler (first match, in registration order, wins). */
  addHandler(handler: SqlMockHandler): SqlMock
  /** Registers a handler that is checked BEFORE all currently-registered handlers — for test-specific overrides layered on top of a shared base setup. */
  prependHandler(handler: SqlMockHandler): SqlMock
  /** Removes all registered handlers. Does not touch `sql`'s call history. */
  clearHandlers(): void
  /** Clears handlers and resets `sql`'s call history/implementation. Call from `beforeEach` for a clean slate between tests. */
  reset(): void
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
  })

  const api: SqlMock = {
    sql,
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
    },
  }

  return api
}
