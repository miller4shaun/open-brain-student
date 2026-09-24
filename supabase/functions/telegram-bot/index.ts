import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
const OWNER_USER_ID      = Deno.env.get('OWNER_USER_ID')!
const OWNER_CHAT_ID      = Deno.env.get('OWNER_CHAT_ID')

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// The service role key bypasses row-level security completely. That is what
// makes this a server rather than a browser - and it is why every query below
// filters by user_id by hand. Nothing does it for you, nothing complains.
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const TELEGRAM_LIMIT = 4000

async function reply(chatId: number | string, text: string) {
  const body = text.length > TELEGRAM_LIMIT
    ? text.slice(0, TELEGRAM_LIMIT) + '\n\n[...truncated]'
    : text
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: body }),
  })
}

function preview(content: string, max = 220) {
  const oneLine = content.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? oneLine.slice(0, max) + '...' : oneLine
}

function when(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
}

async function handleSearch(chatId: number, query: string) {
  if (!query) {
    await reply(chatId, 'What should I search for? Try: /search supabase')
    return
  }
  const { data, error } = await db
    .from('thoughts')
    .select('content, created_at')
    .eq('user_id', OWNER_USER_ID)
    .ilike('content', `%${query}%`)
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) {
    await reply(chatId, `Search failed: ${error.message}`)
    return
  }
  if (!data || data.length === 0) {
    await reply(chatId, `Nothing in your brain matches "${query}".`)
    return
  }
  const lines = data.map((t, i) => `${i + 1}. [${when(t.created_at)}] ${preview(t.content)}`)
  await reply(chatId, `Found ${data.length} for "${query}":\n\n${lines.join('\n\n')}`)
}

async function handleRecent(chatId: number) {
  const { data, error } = await db
    .from('thoughts')
    .select('content, created_at')
    .eq('user_id', OWNER_USER_ID)
    .order('created_at', { ascending: false })
    .limit(5)

  if (error) {
    await reply(chatId, `Could not load: ${error.message}`)
    return
  }
  if (!data || data.length === 0) {
    await reply(chatId, 'Your brain is empty. Send me a thought.')
    return
  }
  const lines = data.map((t, i) => `${i + 1}. [${when(t.created_at)}] ${preview(t.content)}`)
  await reply(chatId, `Your last ${data.length}:\n\n${lines.join('\n\n')}`)
}

async function handleSave(chatId: number, text: string) {
  const { error } = await db.from('thoughts').insert({
    content: text,
    user_id: OWNER_USER_ID,
    metadata: { capture: 'telegram' },
  })
  if (error) {
    await reply(chatId, `Could not save: ${error.message}`)
    return
  }
  await reply(chatId, 'Saved to your brain.')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const update = await req.json()
    const message = update.message ?? update.edited_message
    if (!message) return new Response('ok', { status: 200, headers: corsHeaders })

    const chatId = message.chat?.id
    const text = (message.text ?? '').trim()
    if (!chatId) return new Response('ok', { status: 200, headers: corsHeaders })

    // The door is open (--no-verify-jwt), so check who is knocking.
    if (OWNER_CHAT_ID && String(chatId) !== String(OWNER_CHAT_ID)) {
      await reply(chatId, 'This bot is private.')
      return new Response('ok', { status: 200, headers: corsHeaders })
    }

    if (!text) {
      await reply(chatId, 'I can only read text for now - no photos or files yet.')
      return new Response('ok', { status: 200, headers: corsHeaders })
    }

    if (text === '/start' || text === '/help') {
      await reply(chatId,
        'Your Open Brain.\n\n' +
        'Send me anything and I save it.\n\n' +
        '/search <words> - find what you have saved\n' +
        '? <words> - same thing, shorter\n' +
        '/recent - your last 5\n\n' +
        `This chat's id is ${chatId}. Set it as the OWNER_CHAT_ID secret in ` +
        'Supabase to lock this bot to you only.')
    } else if (text.startsWith('/search')) {
      await handleSearch(chatId, text.slice('/search'.length).trim())
    } else if (text.startsWith('?')) {
      await handleSearch(chatId, text.slice(1).trim())
    } else if (text.startsWith('/recent')) {
      await handleRecent(chatId)
    } else {
      await handleSave(chatId, text)
    }

    return new Response('ok', { status: 200, headers: corsHeaders })
  } catch (e) {
    console.error('telegram-bot error:', e)
    return new Response('ok', { status: 200, headers: corsHeaders })
  }
})
