// Hybrid search for the web app's Search tab.
//
// WHY THIS EXISTS AS A SERVER FUNCTION: search_thoughts needs an embedding of
// the search phrase, and generating one needs the OpenRouter key - a secret
// that can never sit inside a web page where anyone could read it. Same reason
// the browser has never been allowed to call generate-embedding directly.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

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

async function embedQuery(text: string): Promise<number[] | null> {
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // Who is asking? Taken from their own login token, never from the request
    // body - a browser call could put any user id it liked in there.
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) {
      return json({ error: 'Not signed in' }, 401)
    }

    const { query, limit } = await req.json()
    if (!query || typeof query !== 'string' || !query.trim()) {
      return json({ results: [] })
    }

    const matchCount = Math.min(Math.max(1, Number(limit) || 20), 50)

    // A failed embedding is not an error the user should see - it just means
    // this search runs on keywords alone.
    const embedding = await embedQuery(query)

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const { data, error } = await admin.rpc('search_thoughts', {
      query_text: query,
      p_user_id: user.id,
      query_embedding: embedding,
      match_threshold: 0.3,
      match_count: matchCount,
      max_per_document: 2,
    })

    if (error) return json({ error: error.message }, 500)

    return json({
      results: data ?? [],
      semantic: embedding !== null,
    })
  } catch (e) {
    console.error('search-brain error:', String(e))
    return json({ error: String(e) }, 500)
  }
})
