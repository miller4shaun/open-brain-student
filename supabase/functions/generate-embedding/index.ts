// Turns text into 1,536 numbers representing its meaning.
//
// To switch embedding providers, change the model string below. The vector
// dimension must stay 1536 or the embedding column needs a new migration -
// a vector(1536) column will reject a 768-number vector outright.

const OPENROUTER_API_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''
const EMBED_MODEL = Deno.env.get('EMBED_MODEL') ?? 'openai/text-embedding-3-small'

// text-embedding-3-small accepts about 8,000 tokens. Your longest capture is
// 78,000 characters, which is far past that - so truncate rather than let the
// call fail. The first several thousand characters carry the gist, which is
// what an embedding represents anyway.
const MAX_CHARS = 24000

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { text } = await req.json()
    if (!text || typeof text !== 'string' || !text.trim()) {
      return json({ embedding: null, error: 'text is required' }, 400)
    }
    if (!OPENROUTER_API_KEY) {
      return json({ embedding: null, error: 'OPENROUTER_API_KEY is not set' }, 500)
    }

    const res = await fetch('https://openrouter.ai/api/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: text.replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS),
      }),
      signal: AbortSignal.timeout(20_000),
    })

    if (!res.ok) {
      const detail = await res.text()
      console.error('embedding provider HTTP', res.status, detail.slice(0, 300))
      // Return null rather than throwing, so a caller can carry on without
      // an embedding and be backfilled later.
      return json({ embedding: null, error: `provider HTTP ${res.status}` }, 200)
    }

    const data = await res.json()
    const embedding = data?.data?.[0]?.embedding

    if (!Array.isArray(embedding)) {
      console.error('unexpected response shape:', JSON.stringify(data).slice(0, 300))
      return json({ embedding: null, error: 'no embedding in response' }, 200)
    }

    // Catch a model swap that changes dimensions before it reaches the
    // database, where the error would be far less obvious.
    if (embedding.length !== 1536) {
      console.error(`expected 1536 dimensions, got ${embedding.length}`)
      return json({ embedding: null, error: `wrong dimensions: ${embedding.length}` }, 200)
    }

    return json({ embedding, dimensions: embedding.length })
  } catch (e) {
    console.error('generate-embedding error:', String(e))
    return json({ embedding: null, error: String(e) }, 200)
  }
})
