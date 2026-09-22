import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/server/auth'
import { uploadLandingMediaImage, type UploadFileLike } from '@/lib/server/uploads-service'
import { toServiceErrorResponse } from '@/lib/server/http-error'
import { enforceMutationSecurity, enforceRateLimit, RATE_LIMIT_POLICIES } from '@/lib/server/security'
import { ServiceError } from '@/lib/server/service-error'

function toUploadFileLike(value: FormDataEntryValue | null): UploadFileLike | null {
  if (!value || typeof value === 'string' || typeof value.arrayBuffer !== 'function') return null
  return value
}

export async function POST(request: NextRequest) {
  const securityError = enforceMutationSecurity(request)
  if (securityError) return securityError

  const rateLimitError = await enforceRateLimit(request, RATE_LIMIT_POLICIES.adminMutation)
  if (rateLimitError) return rateLimitError

  const admin = await requireAdmin(request)
  if (admin instanceof NextResponse) return admin

  try {
    let formData: FormData
    try {
      formData = await request.formData()
    } catch {
      throw new ServiceError('Invalid upload payload', 400)
    }

    const { pathname } = await uploadLandingMediaImage(admin.session, {
      file: toUploadFileLike(formData.get('file')),
      folder: formData.get('folder'),
    })
    const url = `/api/media/${pathname.slice('landing-media/'.length)}`
    return admin.applyCookies(NextResponse.json({ url }, { status: 201 }))
  } catch (error) {
    return admin.applyCookies(toServiceErrorResponse(error))
  }
}
