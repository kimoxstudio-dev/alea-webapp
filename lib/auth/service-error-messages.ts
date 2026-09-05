import { ERROR_CODES, type AuthErrorCode } from '@/lib/types/error-codes'

/**
 * Maps an `auth-service.ts` `ERROR_CODES.AUTH_*` code (the raw
 * `error.message` a failed `apiClient` call throws — see `lib/api/client.ts`)
 * to its translation key under the `auth.errors` namespace in
 * `messages/en.json` / `messages/es.json` (#313 smoke QA).
 *
 * Shared by every client surface that calls an auth-service-backed endpoint
 * (activation, recovery, admin-issued link generation) so a server error
 * code is never rendered to the user as raw, untranslated text — the defect
 * this fixes. Returns `null` for a code with no mapping (e.g. a network
 * error's message, which is never one of these codes); callers fall back to
 * their own generic, already-translated message in that case.
 *
 * Typed `Record<AuthErrorCode, string>` (not `Partial<Record<string, string>>`)
 * so a new `ERROR_CODES.AUTH_*` value with no entry here is a compile error
 * (#313 code-review finding 8).
 */
const AUTH_ERROR_MESSAGE_KEYS: Record<AuthErrorCode, string> = {
  [ERROR_CODES.AUTH_USER_NOT_FOUND]: 'errors.serviceUserNotFound',
  [ERROR_CODES.AUTH_ONLY_MEMBER_CAN_ACTIVATE]: 'errors.serviceOnlyMemberCanActivate',
  [ERROR_CODES.AUTH_MEMBER_ALREADY_ACTIVE]: 'errors.serviceMemberAlreadyActive',
  [ERROR_CODES.AUTH_ONLY_MEMBER_CAN_RECEIVE_RECOVERY]: 'errors.serviceOnlyMemberCanReceiveRecovery',
  [ERROR_CODES.AUTH_MEMBER_MUST_ACTIVATE_BEFORE_RECOVERY]: 'errors.serviceMemberMustActivateBeforeRecovery',
  [ERROR_CODES.AUTH_INVALID_ACTIVATION_LINK]: 'errors.serviceInvalidActivationLink',
  [ERROR_CODES.AUTH_ACTIVATION_LINK_EXPIRED]: 'errors.serviceActivationLinkExpired',
  [ERROR_CODES.AUTH_ACTIVATION_LINK_USED]: 'errors.serviceActivationLinkUsed',
  [ERROR_CODES.AUTH_ACCOUNT_CREDENTIALS_CREATE_FAILED]: 'errors.serviceAccountCredentialsCreateFailed',
  [ERROR_CODES.AUTH_PASSWORD_REJECTED]: 'errors.servicePasswordRejected',
  [ERROR_CODES.AUTH_PASSWORD_REJECTED_GENERIC]: 'errors.servicePasswordRejectedGeneric',
  [ERROR_CODES.AUTH_ACTIVATION_FAILED]: 'errors.serviceActivationFailed',
  [ERROR_CODES.AUTH_INVALID_RECOVERY_LINK]: 'errors.serviceInvalidRecoveryLink',
  [ERROR_CODES.AUTH_RECOVERY_LINK_EXPIRED]: 'errors.serviceRecoveryLinkExpired',
  [ERROR_CODES.AUTH_RECOVERY_LINK_USED]: 'errors.serviceRecoveryLinkUsed',
  [ERROR_CODES.AUTH_INTERNAL_ERROR]: 'errors.serviceInternalError',
  [ERROR_CODES.AUTH_ACCOUNT_CREDENTIALS_UPDATE_FAILED]: 'errors.serviceAccountCredentialsUpdateFailed',
  [ERROR_CODES.AUTH_RECOVERY_FAILED]: 'errors.serviceRecoveryFailed',
  [ERROR_CODES.AUTH_UNAUTHORIZED]: 'errors.serviceUnauthorized',
}

export function getAuthServiceErrorMessageKey(code: string | undefined | null): string | null {
  if (!code) return null
  return AUTH_ERROR_MESSAGE_KEYS[code as AuthErrorCode] ?? null
}

/**
 * Extracts the machine-readable error code from a caught `unknown` error,
 * regardless of which failure path produced it: `apiClient` (`lib/api/client.ts`)
 * throws a plain `Error` whose `message` is the server's `ERROR_CODES.AUTH_*`
 * code, while a `fetch`-level failure (e.g. network error) throws a `TypeError`
 * — both are real `Error` instances, but some call sites also see a plain
 * object with a string `message` property, so both shapes are handled here.
 * Returns `null` when neither shape matches (#313 code-review round 2, finding 1:
 * this extraction was duplicated identically in 4 call sites).
 */
export function extractErrorCode(error: unknown): string | null {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return null
}
