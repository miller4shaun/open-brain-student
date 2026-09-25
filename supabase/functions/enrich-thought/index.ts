import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const CATEGORIES = ['idea', 'learning', 'question', 'reference', 'plan', 'reflection']
const MAX_CHARS = 6000

// Stricter than the 0.3 used for search: search wants candidates, a link is a
// claim that two things belong together.
const LINK_THRESHOLD = 0.5
const MAX_LINKS = 5

const ok = () => new Response('ok', { status: 200 })

// Calls between your own edge functions need the service role key, or Supabase
// refuses them with a 401 before the target function runs at all.
function internalHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
  }
}

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

async function enrich(content: string, userId: string) {
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

  const res = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
    method: 'POST',
    headers: internalHeaders(),
    body: JSON.stringify({
      prompt, systemPrompt, maxTokens: 400,
      userId, source: 'enrich-thought',
    }),
  })

  if (!res.ok) {
    console.error('call-llm failed:', res.status, (await res.text()).slice(0, 300))
    return null
  }

  const { text, error } = await res.json()
  if (error) {
    console.error('call-llm error:', error)
    return null
  }

  const parsed = parseJson(String(text ?? ''))
  if (!parsed) {
    console.error('could not parse JSON:', String(text).slice(0, 300))
    return null
  }

  return {
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.map((t: any) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 5)
      : [],
    category: CATEGORIES.includes(String(parsed.category)) ? String(parsed.category) : null,
    summary: parsed.summary ? String(parsed.summary).slice(0, 300) : null,
  }
}

async function embed(content: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
      method: 'POST',
      headers: internalHeaders(),
      body: JSON.stringify({ text: content }),
    })
    if (!res.ok) {
      console.error('generate-embedding HTTP', res.status)
      return null
    }
    const { embedding, error } = await res.json()
    if (error) console.warn('embedding unavailable:', error)
    return Array.isArray(embedding) ? embedding : null
  } catch (e) {
    console.error('embed failed:', String(e))
    return null
  }
}

async function linkNeighbours(thoughtId: string, userId: string, embedding: number[]) {
  try {
    const { data: neighbours, error } = await db.rpc('find_links_for_thought', {
      source_id: thoughtId,
      source_embedding: embedding,
      p_user_id: userId,
      match_threshold: LINK_THRESHOLD,
      match_count: MAX_LINKS,
    })

    if (error) {
      console.error('find_links_for_thought failed:', error.message)
      return 0
    }
    if (!neighbours || neighbours.length === 0) return 0

    const links = neighbours.map((n: any) => ({
      source_thought_id: thoughtId,
      target_thought_id: n.target_id,
      user_id: userId,
      similarity_score: n.similarity,
      link_type: 'semantic',
    }))

    // ignoreDuplicates so an existing link is skipped rather than raising.
    // The canonical index also refuses the reverse direction, which shows up
    // here as a duplicate and is silently skipped - exactly what we want.
    const { error: linkError } = await db
      .from('thought_links')
      .upsert(links, {
        onConflict: 'source_thought_id,target_thought_id',
        ignoreDuplicates: true,
      })

    if (linkError) {
      console.warn('some links not saved:', linkError.message)
      return 0
    }
    return links.length
  } catch (e) {
    console.error('linkNeighbours failed:', String(e))
    return 0
  }
}

Deno.serve(async (req) => {
  try {
    const payload = await req.json()
    const record = payload?.record
    if (!record?.id) return ok()

    const content = String(record.content ?? '')
    const thoughtId = String(record.id)
    const userId = record.user_id ? String(record.user_id) : null

    if (content.trim().length < 20) {
      console.log('too short to enrich, skipping', thoughtId)
      return ok()
    }
    if (!userId) {
      console.warn('thought has no user_id, skipping', thoughtId)
      return ok()
    }

    // In parallel - they do not depend on each other, and running them one
    // after the other doubles how long this takes for no reason.
    const [enrichment, embedding] = await Promise.all([
      enrich(content, userId),
      embed(content),
    ])

    const update: Record<string, unknown> = { enriched_at: new Date().toISOString() }
    if (enrichment) {
      update.tags = enrichment.tags
      update.category = enrichment.category
      update.summary = enrichment.summary
    }
    if (embedding) update.embedding = embedding

    const { error: updateError } = await db
      .from('thoughts')
      .update(update)
      .eq('id', thoughtId)

    if (updateError) {
      console.error('update failed:', updateError.message)
      return ok()
    }

    let linked = 0
    if (embedding) linked = await linkNeighbours(thoughtId, userId, embedding)

    console.log(
      `enriched ${thoughtId}`,
      `category=${enrichment?.category ?? 'none'}`,
      `embedded=${embedding ? 'yes' : 'no'}`,
      `links=${linked}`,
    )

    return ok()
  } catch (e) {
    console.error('enrich-thought error:', String(e))
    return ok()
  }
})
