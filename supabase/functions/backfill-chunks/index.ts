// One-time catch-up: chunk everything captured before chunking existed.
//
// Works biggest-document-first. If the run gets interrupted, the documents that
// benefit most from chunking are already done.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { saveThoughtChunksSafe } from '../_shared/thought-chunks.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req: Request) => {
  try {
    const body = await req.json().catch(() => ({}))
    const dryRun = body?.dry_run === true
    // Small batches on purpose: one 76,000-character document is ~60 embedding
    // calls on its own. A batch of 10 such documents would not finish in time.
    const batchSize = Math.min(Math.max(1, Number(body?.batch_size) || 3), 10)

    const { data: pending, error } = await db
      .from('thoughts_needing_chunks')
      .select('id, chars')
      .order('chars', { ascending: false })
      .limit(batchSize)

    if (error) return json({ error: error.message }, 500)

    if (dryRun) {
      const { count } = await db
        .from('thoughts_needing_chunks')
        .select('id', { count: 'exact', head: true })
      return json({ dry_run: true, needs_chunks: count ?? 0 })
    }

    if (!pending || pending.length === 0) {
      return json({ processed: 0, chunked: 0, remaining: 0 })
    }

    let chunked = 0

    for (const row of pending) {
      // The view carries only id and length - fetch the content itself here
      // rather than dragging 76,000 characters through the listing query.
      const { data: thought } = await db
        .from('thoughts')
        .select('id, content')
        .eq('id', row.id)
        .single()

      if (!thought?.content) continue

      const result = await saveThoughtChunksSafe(
        db, thought.id, String(thought.content), 'backfill-chunks', 'summary',
      )
      chunked += result.chunked
    }

    const { count } = await db
      .from('thoughts_needing_chunks')
      .select('id', { count: 'exact', head: true })

    return json({ processed: pending.length, chunked, remaining: count ?? 0 })
  } catch (e) {
    console.error('backfill-chunks error:', String(e))
    return json({ error: String(e) }, 500)
  }
})
