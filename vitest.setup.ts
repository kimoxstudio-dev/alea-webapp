import '@testing-library/jest-dom'
import { vi } from 'vitest'

// Set a dummy DATABASE_URL for tests before any modules are imported
// This prevents lib/db/client from throwing when modules are loaded in tests
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost/test'

// Mock server-only module to allow tests to import server modules
vi.mock('server-only', () => ({}))
