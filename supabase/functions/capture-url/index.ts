import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const MAX_BYTES = 3_000_000 // do not try to swallow a 50MB page

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// Decode entities, &amp; LAST so a double-escaped "&amp;lt;" cannot become "<".
function decodeEntities(input: string): string {
  let s = input
  const pairs: [string, string][] = [
    ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&apos;', "'"],
    ['&nbsp;', ' '], ['&rsquo;', '\u2019'], ['&lsquo;', '\u2018'],
    ['&rdquo;', '\u201D'], ['&ldquo;', '\u201C'],
    ['&mdash;', '\u2014'], ['&ndash;', '\u2013'], ['&hellip;', '\u2026'],
    ['&aacute;', '\u00E1'], ['&eacute;', '\u00E9'], ['&iacute;', '\u00ED'],
    ['&oacute;', '\u00F3'], ['&uacute;', '\u00FA'], ['&ntilde;', '\u00F1'],
    ['&uuml;', '\u00FC'], ['&iexcl;', '\u00A1'], ['&iquest;', '\u00BF'],
  ]
  for (const [ent, ch] of pairs) s = s.split(ent).join(ch)
  s = s.replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
  return s.split('&amp;').join('&')
}

// Strip the machinery, keep the prose. Deliberately simple - no library.
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch =
    html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : 'Untitled page'

  const articleMatch =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  const body = articleMatch ? articleMatch[1] : html

  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  const cleaned = decodeEntities(text)
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  return { title, text: cleaned }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // Who is asking? Read it from their login token, never from the request
    // body - trusting a user id sent by the caller would let anyone write
    // into anyone else's brain.
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) {
      return jsonResponse({ ok: false, error: 'Not signed in' }, 401)
    }

    const { url } = await req.json()
    if (!url || typeof url !== 'string') {
      return jsonResponse({ ok: false, error: 'A url is required' }, 400)
    }

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return jsonResponse({ ok: false, error: 'That is not a valid web address' }, 400)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return jsonResponse({ ok: false, error: 'Only http and https links are supported' }, 400)
    }

    const pageRes = await fetch(parsed.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })

    if (!pageRes.ok) {
      return jsonResponse({
        ok: false,
        error: `That page returned HTTP ${pageRes.status}. It may need a login, or it blocks automated readers.`,
      }, 422)
    }

    const contentType = pageRes.headers.get('content-type') ?? ''
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return jsonResponse({
        ok: false,
        error: `That link is a ${contentType.split(';')[0] || 'file'}, not a web page. For PDFs, use the PDF tab.`,
      }, 415)
    }

    const raw = await pageRes.text()
    if (raw.length > MAX_BYTES) {
      return jsonResponse({ ok: false, error: 'That page is too large to process' }, 413)
    }

    const { title, text } = htmlToText(raw)

    if (text.length < 200) {
      return jsonResponse({
        ok: false,
        error:
          'Almost no readable text was found. The page probably builds itself with ' +
          'JavaScript after loading, which a server cannot see. Paste the text in by hand instead.',
      }, 422)
    }

    // Level 5 adds the AI that turns this raw text into a summary. For now the
    // full text is what gets saved.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    const { data: thought, error: insertError } = await admin
      .from('thoughts')
      .insert({
        user_id: user.id,
        content: `\u{1F517} ${title}\n${parsed.toString()}\n\n${text.slice(0, 8000)}`,
        metadata: { capture: 'url', title, url: parsed.toString() },
      })
      .select('id')
      .single()

    if (insertError || !thought) {
      return jsonResponse({ ok: false, error: insertError?.message ?? 'Could not save' }, 500)
    }

    // Non-fatal, same rule as Level 2 - the thought is already saved.
    try {
      await admin.from('thought_sources').insert({
        thought_id: thought.id,
        user_id: user.id,
        source_text: text,
        source_kind: 'web',
        char_count: text.length,
        truncated: false,
      })
    } catch (e) {
      console.warn('thought_sources insert failed:', String(e))
    }

    return jsonResponse({ ok: true, title, chars: text.length })
  } catch (e) {
    console.error('capture-url error:', String(e))
    return jsonResponse({ ok: false, error: String(e) }, 500)
  }
})
