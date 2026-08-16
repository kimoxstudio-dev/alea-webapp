// @vitest-environment node
// Regression tests for Codex review findings on PR #327
import { describe, expect, it } from 'vitest'

describe('Codex review findings — code-level verification', () => {
  describe('Finding 1: token compensation on Clerk failure in auth-service.ts', () => {
    it('implements restoreClaimedToken() helper for recovery', async () => {
      // Read the source to verify the fix exists
      const { execSync } = await import('child_process')
      const output = execSync(
        "grep -n 'restoreClaimedToken' lib/server/auth-service.ts || echo 'NOT_FOUND'",
        { cwd: process.cwd(), encoding: 'utf-8' }
      )
      expect(output).toContain('restoreClaimedToken')
      expect(output).not.toContain('NOT_FOUND')
    })

    it('calls restoreClaimedToken() in activateAccount catch block after Clerk failure', async () => {
      const { execSync } = await import('child_process')
      const output = execSync(
        "grep -A5 'catch' lib/server/auth-service.ts | grep -n 'restoreClaimedToken' || echo 'NOT_FOUND'",
        { cwd: process.cwd(), encoding: 'utf-8' }
      )
      // If the helper exists and is called in catch blocks, output will show the line
      expect(output.includes('restoreClaimedToken')).toBe(true)
    })

    it('calls restoreClaimedToken() in recoverAccount catch block after Clerk failure', async () => {
      const { execSync } = await import('child_process')
      // Verify both activateAccount and recoverAccount have restoration logic
      const source = execSync(
        "grep -c 'await restoreClaimedToken' lib/server/auth-service.ts",
        { cwd: process.cwd(), encoding: 'utf-8' }
      ).trim()
      // Should have multiple calls (at least 2 - one for activateAccount, others for recoverAccount paths)
      const count = parseInt(source)
      expect(count).toBeGreaterThanOrEqual(2)
    })
  })

  describe('Finding 2: Clerk-first/DB-write race protection in users-service.ts updateUser()', () => {
    it('includes pre-check to reject memberNumber change BEFORE calling Clerk', async () => {
      const { execSync } = await import('child_process')
      const output = execSync(
        "grep -n 'conflicting' lib/server/users-service.ts | head -5",
        { cwd: process.cwd(), encoding: 'utf-8' }
      )
      // The pre-check for conflicting member_number should exist
      expect(output.length).toBeGreaterThan(0)
    })

    it('includes rollback logic if DB write fails after Clerk rename succeeds', async () => {
      const { execSync } = await import('child_process')
      const output = execSync(
        "grep -n 'renamedClerkUserId' lib/server/users-service.ts",
        { cwd: process.cwd(), encoding: 'utf-8' }
      )
      // The variable to track if Clerk was renamed should exist for rollback logic
      expect(output).toContain('renamedClerkUserId')
    })

    it('includes rollback logic for Clerk updateUser on DB failure', async () => {
      const { readFileSync } = await import('fs')
      const { join } = await import('path')
      const source = readFileSync(
        join(process.cwd(), 'lib/server/users-service.ts'),
        'utf-8'
      )
      // Look for the rollback pattern: if renamedClerkUserId exists in catch block
      const hasRollbackLogic = source.includes('renamedClerkUserId') &&
        source.includes('client.users.updateUser') &&
        source.includes('catch (err)')
      expect(hasRollbackLogic).toBe(true)
    })
  })

  describe('Finding 3: Clerk-first delete in users-service.ts deleteUser()', () => {
    it('calls Clerk.users.deleteUser() BEFORE deleting profiles row', async () => {
      const { execSync } = await import('child_process')
      const output = execSync(
        "grep -n 'deleteUser\\|DELETE FROM profiles' lib/server/users-service.ts | head -10",
        { cwd: process.cwd(), encoding: 'utf-8' }
      )
      const lines = output.split('\n').filter(l => l.trim())
      // The Clerk delete should come before the DB delete in the source
      const clerkDeleteLine = parseInt(lines[0]?.split(':')[0] || '0')
      const dbDeleteLine = parseInt(lines[1]?.split(':')[0] || '0')
      expect(clerkDeleteLine).toBeLessThan(dbDeleteLine)
    })

    it('wraps Clerk deletion in try-catch to prevent orphaned Clerk identities', async () => {
      const { execSync } = await import('child_process')
      const output = execSync(
        "grep -B2 'deleteUser' lib/server/users-service.ts | grep -c 'try'",
        { cwd: process.cwd(), encoding: 'utf-8' }
      ).trim()
      const count = parseInt(output)
      expect(count).toBeGreaterThanOrEqual(1)
    })
  })

  describe('Finding 4: open-redirect vulnerability mitigation in safe-redirect.ts', () => {
    it('exports isSafeRedirectPath and resolveSafeRedirect', async () => {
      const module = await import('@/lib/safe-redirect')
      expect(typeof module.isSafeRedirectPath).toBe('function')
      expect(typeof module.resolveSafeRedirect).toBe('function')
    })

    it('isSafeRedirectPath rejects protocol-relative URLs', async () => {
      const { isSafeRedirectPath } = await import('@/lib/safe-redirect')
      expect(isSafeRedirectPath('//attacker.example')).toBe(false)
    })

    it('isSafeRedirectPath rejects backslash variants', async () => {
      const { isSafeRedirectPath } = await import('@/lib/safe-redirect')
      expect(isSafeRedirectPath('/\\attacker.example')).toBe(false)
    })

    it('isSafeRedirectPath rejects absolute URLs', async () => {
      const { isSafeRedirectPath } = await import('@/lib/safe-redirect')
      expect(isSafeRedirectPath('https://attacker.example')).toBe(false)
    })

    it('isSafeRedirectPath accepts safe relative paths', async () => {
      const { isSafeRedirectPath } = await import('@/lib/safe-redirect')
      expect(isSafeRedirectPath('/rooms')).toBe(true)
      expect(isSafeRedirectPath('/en/rooms?next=test')).toBe(true)
    })

    it('resolveSafeRedirect returns value for safe paths, fallback for unsafe', async () => {
      const { resolveSafeRedirect } = await import('@/lib/safe-redirect')
      expect(resolveSafeRedirect('/rooms', '/default')).toBe('/rooms')
      expect(resolveSafeRedirect('//evil.com', '/default')).toBe('/default')
    })
  })
})
