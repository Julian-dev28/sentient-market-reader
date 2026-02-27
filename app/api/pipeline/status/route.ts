import { NextResponse } from 'next/server'
import { isPipelineLocked, getLastAnalysis } from '@/lib/pipeline-lock'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json({
    running: isPipelineLocked(),
    lastAnalysis: getLastAnalysis() ?? null,
  })
}
