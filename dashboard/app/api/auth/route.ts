import { NextResponse } from 'next/server'
import { execFileSync, execSync } from 'child_process'
import { ghAvailable, ghArgsRepo } from '@/lib/gh'

export async function GET() {
  try {
    if (!ghAvailable()) {
      return NextResponse.json({ authenticated: false, error: 'gh CLI not authenticated' })
    }

    const out = execFileSync('gh', ['secret', 'list', ...ghArgsRepo(), '--json', 'name', '-q', '.[].name'], {
      stdio: 'pipe',
    }).toString().trim()
    const secrets = out ? out.split('\n').filter(Boolean) : []
    const hasApiKey = secrets.includes('ANTHROPIC_API_KEY')
    const hasOauth = secrets.includes('CLAUDE_CODE_OAUTH_TOKEN')

    return NextResponse.json({ authenticated: hasApiKey || hasOauth, hasApiKey, hasOauth })
  } catch {
    return NextResponse.json({ authenticated: false })
  }
}

export async function POST(request: Request) {
  try {
    if (!ghAvailable()) {
      return NextResponse.json({ error: 'gh CLI not authenticated. Run: gh auth login' }, { status: 503 })
    }

    const body = await request.json().catch(() => ({})) as { key?: string }

    if (body.key) {
      const key = body.key.trim()
      if (!key.startsWith('sk-ant-')) {
        return NextResponse.json(
          { error: 'Expected an Anthropic API key or Claude OAuth token starting with sk-ant-' },
          { status: 400 },
        )
      }

      const isOauth = key.startsWith('sk-ant-oat')
      const secretName = isOauth ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'
      execFileSync('gh', ['secret', 'set', secretName, ...ghArgsRepo()], {
        input: key,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      return NextResponse.json({ ok: true, method: isOauth ? 'oauth' : 'api-key', secret: secretName })
    }

    const output = execSync('claude setup-token', {
      stdio: 'pipe',
      timeout: 60000,
    }).toString()

    const tokenBlock = output.slice(output.indexOf('sk-ant-oat'))
    if (!tokenBlock.startsWith('sk-ant-oat')) {
      return NextResponse.json({
        error: 'Could not extract token. Paste your API key manually instead.',
      }, { status: 400 })
    }

    const tokenChars: string[] = []
    for (const line of tokenBlock.split('\n')) {
      const segment = line.trim().match(/^[A-Za-z0-9_\-]+/)?.[0] ?? ''
      if (!segment) break
      tokenChars.push(segment)
    }
    const token = tokenChars.join('')

    if (!token.startsWith('sk-ant-oat')) {
      return NextResponse.json({
        error: 'Could not extract a valid OAuth token. Paste your API key manually instead.',
      }, { status: 400 })
    }

    execFileSync('gh', ['secret', 'set', 'CLAUDE_CODE_OAUTH_TOKEN', ...ghArgsRepo()], {
      input: token,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    return NextResponse.json({ ok: true, method: 'oauth' })
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to setup auth'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
