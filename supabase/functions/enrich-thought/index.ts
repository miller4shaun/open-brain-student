// Runs every time a thought is inserted, via a Supabase database webhook.
// Adds tags, a category and a one-line summary.
//
// Always returns 200. A webhook that returns an error gets retried, and a
// retried enrichment just spends money again on a thought that is already fine.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const CATEGORIES = ['idea', 'learning', 'question', 'reference', 'plan', 'reflection']

// A captured PDF or transcript can run to 78,000 characters. Sending all of it
// to be tagged would cost real money for no extra accuracy - the first few
// thousand characters tell you what something is about.
const MAX_CHARS = 6000

const ok = () => new Response('ok', { status: 200 })

// Models sometimes wrap JSON in markdown fences or add a sentence before it.
// Take the outermost braces and parse those.
function parseJson(text: string): any | null {
  try {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1) return null
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  try {
    const payload = await req.json()
    const record = payload?.record
    if (!record?.id) return ok()

    const content = String(record.content ?? '')
    if (content.trim().length < 20) {
      console.log('too short to enrich, skipping', record.id)
      return ok()
    }

    const systemPrompt =
      'You label items in a personal knowledge base. You reply with JSON only, ' +
      'no explanation, no markdown fences.'

    const prompt =
      'Read this captured item and return JSON with exactly three fields:\n' +
      '  "tags": an array of 3 to 5 short lowercase tags\n' +
      `  "category": exactly one of ${CATEGORIES.join(', ')}\n` +
      '  "summary": one sentence, max 25 words, saying what this is about\n\n' +
      'Be specific. "golf-handicap" beats "golf". "sports" tells the reader nothing.\n\n' +
      'ITEM:\n' + content.slice(0, MAX_CHARS)

    // Calling one of your own functions needs the service role key, same as any
    // other caller. Without this header you get a 401 and no explanation.
    const res = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        prompt,
        systemPrompt,
        maxTokens: 400,
        userId: record.user_id,
        source: 'enrich-thought',
      }),
    })

    if (!res.ok) {
      console.error('call-llm failed:', res.status, (await res.text()).slice(0, 300))
      return ok()
    }

    const { text, error } = await res.json()
    if (error) {
      console.error('call-llm error:', error)
      return ok()
    }

    const parsed = parseJson(String(text ?? ''))
    if (!parsed) {
      console.error('could not parse JSON from model:', String(text).slice(0, 300))
      return ok()
    }

    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.map((t: any) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 5)
      : []
    const category = CATEGORIES.includes(String(parsed.category))
      ? String(parsed.category)
      : null
    const summary = parsed.summary ? String(parsed.summary).slice(0, 300) : null

    const { error: updateError } = await db
      .from('thoughts')
      .update({ tags, category, summary, enriched_at: new Date().toISOString() })
      .eq('id', record.id)

    if (updateError) console.error('update failed:', updateError.message)
    else console.log('enriched', record.id, category, tags.join('/'))

    return ok()
  } catch (e) {
    console.error('enrich-thought error:', String(e))
    return ok()
  }
})
