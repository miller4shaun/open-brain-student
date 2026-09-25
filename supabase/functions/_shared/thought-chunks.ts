// Saves a thought's chunks, each with its own embedding.
//
// Adapted from the pre-built Express version: that one imports a generateEmbedding
// helper from its own shared AI module. This project generates embeddings through
// the generate-embedding edge function built in Level 6, so the call goes over
// HTTP to your own function instead.

import { chunkText, shouldChunk, type TextChunk } from './chunking.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// One 76,000-character page becomes around 60 chunks. Doing 60 HTTP calls one
// after another would take most of an edge function's time budget; doing all 60
// at once would hammer the provider's rate limit. Four at a time is the middle.
const CONCURRENCY = 4

// A runaway document should not be able to spend unbounded money or time.
const MAX_CHUNKS_PER_THOUGHT = 80

async function embedOne(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/generate-embedding`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ text }),
    })
    if (!res.ok) return null
    const { embedding } = await res.json()
    return Array.isArray(embedding) ? embedding : null
  } catch {
    return null
  }
}

/** Run tasks with a fixed number in flight at once. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

export interface ChunkSaveResult {
  chunked: number
  skipped: boolean
  reason?: string
}

/**
 * Never throws. Chunking is an enhancement — if it fails, the thought that was
 * already saved is unaffected, and a backfill can pick it up later.
 *
 * Silently does nothing for content under 2,000 characters, so callers can
 * invoke it on every thought without checking the length first.
 */
export async function saveThoughtChunksSafe(
  db: any,
  thoughtId: string,
  content: string,
  source: string,
  origin = 'summary',
): Promise<ChunkSaveResult> {
  try {
    if (!shouldChunk(content)) return { chunked: 0, skipped: true, reason: 'too short' }

    const chunks = chunkText(content).slice(0, MAX_CHUNKS_PER_THOUGHT)
    if (chunks.length === 0) return { chunked: 0, skipped: true, reason: 'no usable chunks' }

    const embeddings = await mapLimit(chunks, CONCURRENCY, (c: TextChunk) => embedOne(c.text))

    const rows = chunks
      .map((c: TextChunk, i: number) => ({
        thought_id: thoughtId,
        origin,
        chunk_index: c.index,
        content: c.text,
        char_start: c.charStart,
        char_end: c.charEnd,
        embedding: embeddings[i],
      }))
      // A chunk with no embedding is still worth storing: keyword search over
      // content_tsv works on it even when the vector side is missing.
      .filter((r: { content: string }) => r.content && r.content.trim().length > 0)

    if (rows.length === 0) return { chunked: 0, skipped: true, reason: 'nothing to write' }

    // Re-running over the same thought updates in place rather than duplicating,
    // thanks to the unique (thought_id, origin, chunk_index) constraint.
    const { error } = await db
      .from('thought_chunks')
      .upsert(rows, { onConflict: 'thought_id,origin,chunk_index' })

    if (error) {
      console.warn(`[${source}] chunk write failed for ${thoughtId}:`, error.message)
      return { chunked: 0, skipped: true, reason: error.message }
    }

    const embedded = embeddings.filter(Boolean).length
    console.log(`[${source}] chunked ${thoughtId}: ${rows.length} chunks, ${embedded} embedded`)
    return { chunked: rows.length, skipped: false }
  } catch (e) {
    console.warn(`[${source}] chunking threw for ${thoughtId}:`, String(e))
    return { chunked: 0, skipped: true, reason: String(e) }
  }
}
