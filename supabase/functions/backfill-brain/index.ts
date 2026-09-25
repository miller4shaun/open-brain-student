// One-time catch-up for thoughts saved before embeddings existed.
//
// Two phases, and the order matters: every thought needs an embedding before
// ANY thought can be linked, because linking compares against neighbours that
// already have one. Run phase 'embed' to completion, then phase 'link'.
//
// Small batches on purpose. Supabase edge functions have a time limit, and a
// batch that tries to do too much gets killed halfway with no useful error.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const LINK_THRESHOLD = 0.5
const MAX_LINKS = 5

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function internalHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
  }
}

async function embed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
      method: 'POST',
      headers: internalHeaders(),
      body: JSON.stringify({ text }),
    })
    if (!res.ok) return null
    const { embedding } = await res.json()
    return Array.isArray(embedding) ? embedding : null
  } catch {
    return null
  }
}

async function phaseEmbed(batchSize: number) {
  const { data: rows, error } = await db
    .from('thoughts')
    .select('id, content')
    .is('embedding', null)
    .order('created_at', { ascending: true })
    .limit(batchSize)

  if (error) return json({ error: error.message }, 500)
  if (!rows || rows.length === 0) return json({ phase: 'embed', processed: 0, remaining: 0 })

  let done = 0
  let failed = 0

  for (const row of rows) {
    const content = String(row.content ?? '')
    if (content.trim().length < 20) {
      // Too short to be worth embedding, but it must stop appearing in this
      // query or the loop never finishes. A zero vector marks it as handled.
      await db.from('thoughts').update({ embedding: new Array(1536).fill(0) }).eq('id', row.id)
      done++
      continue
    }
    const embedding = await embed(content)
    if (!embedding) { failed++; continue }
    const { error: upErr } = await db.from('thoughts').update({ embedding }).eq('id', row.id)
    if (upErr) failed++
    else done++
  }

  const { count } = await db
    .from('thoughts')
    .select('id', { count: 'exact', head: true })
    .is('embedding', null)

  return json({ phase: 'embed', processed: rows.length, embedded: done, failed, remaining: count ?? 0 })
}

async function phaseLink(batchSize: number) {
  const { data: rows, error } = await db
    .from('thoughts')
    .select('id, user_id, embedding')
    .is('linked_at', null)
    .not('embedding', 'is', null)
    .order('created_at', { ascending: true })
    .limit(batchSize)

  if (error) return json({ error: error.message }, 500)
  if (!rows || rows.length === 0) return json({ phase: 'link', processed: 0, remaining: 0 })

  let linksMade = 0

  for (const row of rows) {
    try {
      if (row.user_id) {
        const { data: neighbours } = await db.rpc('find_links_for_thought', {
          source_id: row.id,
          source_embedding: row.embedding,
          p_user_id: row.user_id,
          match_threshold: LINK_THRESHOLD,
          match_count: MAX_LINKS,
        })

        if (neighbours && neighbours.length > 0) {
          const links = neighbours.map((n: any) => ({
            source_thought_id: row.id,
            target_thought_id: n.target_id,
            user_id: row.user_id,
            similarity_score: n.similarity,
            link_type: 'semantic',
          }))
          await db.from('thought_links').upsert(links, {
            onConflict: 'source_thought_id,target_thought_id',
            ignoreDuplicates: true,
          })
          linksMade += links.length
        }
      }
    } catch (e) {
      console.error('link failed for', row.id, String(e))
    }
    // Marked either way. A thought with no neighbours is DONE, not pending -
    // without this the loop would see it forever.
    await db.from('thoughts').update({ linked_at: new Date().toISOString() }).eq('id', row.id)
  }

  const { count } = await db
    .from('thoughts')
    .select('id', { count: 'exact', head: true })
    .is('linked_at', null)
    .not('embedding', 'is', null)

  return json({ phase: 'link', processed: rows.length, links: linksMade, remaining: count ?? 0 })
}

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}))
    const phase = body?.phase === 'link' ? 'link' : 'embed'
    const batchSize = Math.min(Math.max(1, Number(body?.batch_size) || 5), 10)

    return phase === 'embed' ? await phaseEmbed(batchSize) : await phaseLink(batchSize)
  } catch (e) {
    console.error('backfill-brain error:', String(e))
    return json({ error: String(e) }, 500)
  }
})
