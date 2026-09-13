/**
 * Extracts the machine-readable error code from a caught `unknown` error,
 * regardless of which failure path produced it: `apiClient` (`lib/api/client.ts`)
 * throws the parsed JSON error body (`{ message: '<ERROR_CODE>', statusCode }`)
 * on a failed response, while a `fetch`-level failure (e.g. network error)
 * throws a real `TypeError` — both carry a string `message`, so both shapes
 * are handled here.
 *
 * Shared by every client surface that maps a server error code to a
 * translated message (auth: `lib/auth/service-error-messages.ts`; club
 * events: `lib/club-events/error-messages.ts`) — generic over any error
 * shape, with nothing domain-specific about it, so it lives in its own
 * neutral module rather than inside one domain's message-mapping file.
 * Returns `null` when neither shape matches.
 */
export function extractErrorCode(error: unknown): string | null {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return null
}
