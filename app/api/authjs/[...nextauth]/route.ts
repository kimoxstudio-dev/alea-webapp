import { NextRequest, NextResponse } from 'next/server'

/**
 * Permanent tombstone for the retired Auth.js endpoint.
 *
 * Keep the path unreachable even if stale environments still define
 * AUTH_JS_ENABLED. Removing this route entirely would allow a future catch-all
 * route to claim the old authentication URL accidentally.
 */
export async function GET(_request: NextRequest) {
  return new NextResponse(null, { status: 404 })
}

export async function POST(_request: NextRequest) {
  return new NextResponse(null, { status: 404 })
}
