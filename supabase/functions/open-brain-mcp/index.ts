import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const MCP_ACCESS_KEY = Deno.env.get('MCP_ACCESS_KEY')!
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID')!

// The service role key bypasses row-level security. Every query below filters
// by OWNER_USER_ID by hand - and add_thought sets it, or the row would save
// with no owner and be invisible in your own app.
const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const DEFAULT_PROTOCOL = '2024-11-05'

// Claude reads these descriptions to decide when to call them, so they are
// written for a reader, not a spec.
const TOOLS = [
  {
    name: 'search_thoughts',
    description:
      "Search the user's personal knowledge base (their 'brain') for anything " +
      'they have captured: notes, YouTube transcripts, PDF extracts, saved ' +
      'articles, voice notes and messages. Use this whenever the user refers ' +
      'to something they saved, read, watched, or wrote down.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words or phrase to look for' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_recent',
    description:
      "List the most recently captured items from the user's brain, newest " +
      'first. Use this to see what they have been thinking about lately.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many to return (default 10, max 50)' },
      },
    },
  },
  {
    name: 'get_thought',
    description:
      'Fetch one item from the brain in full, by its id. Use this after ' +
      'search_thoughts or list_recent when a preview looks relevant and you ' +
      'need the whole text.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id shown in a search result' },
      },
      required: ['id'],
    },
  },
  {
    name: 'add_thought',
    description:
      "Save a new thought into the user's brain. Use this when they ask you " +
      'to remember, note, or save something.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The text to save' },
      },
      required: ['content'],
    },
  },
]

function rpcResult(id: unknown, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function rpcError(id: unknown, code: number, message: string) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// MCP tool results are a list of content blocks. Plain text is enough here.
function textResult(id: unknown, text: string, isError = false) {
  return rpcResult(id, { content: [{ type: 'text', text }], isError })
}

function fmt(iso: string) {
  return new Date(iso).toISOString().slice(0, 10)
}

// Search returns excerpts, not whole documents. A single PDF or transcript can
// run to 78,000 characters - ten of those would bury any AI. Show enough to
// judge relevance, report the true size, and let get_thought fetch the rest.
const PREVIEW_CHARS = 500

function preview(content: string) {
  const flat = content.replace(/\s+/g, ' ').trim()
  if (flat.length <= PREVIEW_CHARS) return flat
  return flat.slice(0, PREVIEW_CHARS) + '...'
}

function summarise(t: any, i: number) {
  const size = String(t.content ?? '').length
  return `[${i + 1}] ${fmt(t.created_at)} | ${size.toLocaleString()} chars | id ${t.id}\n` +
         preview(String(t.content ?? ''))
}

async function searchThoughts(query: string) {
  const { data, error } = await db
    .from('thoughts')
    .select('id, content, created_at')
    .eq('user_id', OWNER_USER_ID)
    .ilike('content', `%${query}%`)
    .order('created_at', { ascending: false })
    .limit(10)
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) return `No thoughts found matching "${query}".`
  return data
    .map(summarise)
    .join('\n\n---\n\n')
}

async function listRecent(limit: number) {
  const n = Math.min(Math.max(1, Math.floor(limit || 10)), 50)
  const { data, error } = await db
    .from('thoughts')
    .select('id, content, created_at')
    .eq('user_id', OWNER_USER_ID)
    .order('created_at', { ascending: false })
    .limit(n)
  if (error) throw new Error(error.message)
  if (!data || data.length === 0) return 'The brain is empty.'
  return data
    .map(summarise)
    .join('\n\n---\n\n')
}

async function getThought(id: string) {
  const { data, error } = await db
    .from('thoughts')
    .select('id, content, created_at, metadata')
    .eq('user_id', OWNER_USER_ID)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return `No thought with id ${id}.`
  return `${fmt(data.created_at)} | id ${data.id}\n\n${data.content}`
}

async function addThought(content: string) {
  const { data, error } = await db
    .from('thoughts')
    .insert({
      content,
      user_id: OWNER_USER_ID,
      metadata: { capture: 'mcp' },
    })
    .select('id, created_at')
    .single()
  if (error) throw new Error(error.message)
  return `Saved. id ${data.id}, ${fmt(data.created_at)}`
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  // The door is open (--no-verify-jwt), so check who is knocking. This runs
  // before anything else, including parsing the body.
  const auth = req.headers.get('Authorization') ?? ''
  if (auth !== `Bearer ${MCP_ACCESS_KEY}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return rpcError(null, -32700, 'Parse error')
  }

  const { id, method, params } = body ?? {}

  try {
    // A JSON-RPC message with no id is a notification: acknowledge, say nothing.
    if (method && String(method).startsWith('notifications/')) {
      return new Response(null, { status: 202, headers: corsHeaders })
    }

    if (method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'open-brain', version: '1.0.0' },
      })
    }

    if (method === 'tools/list') {
      return rpcResult(id, { tools: TOOLS })
    }

    if (method === 'tools/call') {
      const name = params?.name
      const args = params?.arguments ?? {}
      try {
        if (name === 'search_thoughts') {
          if (!args.query) return textResult(id, 'A query is required.', true)
          return textResult(id, await searchThoughts(String(args.query)))
        }
        if (name === 'list_recent') {
          return textResult(id, await listRecent(Number(args.limit ?? 10)))
        }
        if (name === 'get_thought') {
          if (!args.id) return textResult(id, 'An id is required.', true)
          return textResult(id, await getThought(String(args.id)))
        }
        if (name === 'add_thought') {
          if (!args.content) return textResult(id, 'Content is required.', true)
          return textResult(id, await addThought(String(args.content)))
        }
        return textResult(id, `Unknown tool: ${name}`, true)
      } catch (toolErr) {
        // A tool failing is a normal result, not a protocol error. Report it
        // back so the AI can tell the user, instead of the call vanishing.
        return textResult(id, `Tool failed: ${String(toolErr)}`, true)
      }
    }

    if (method === 'ping') return rpcResult(id, {})

    return rpcError(id ?? null, -32601, `Method not found: ${method}`)
  } catch (e) {
    console.error('open-brain-mcp error:', String(e))
    return rpcError(id ?? null, -32603, String(e))
  }
})
