// Runs every Sunday at 8am via pg_cron. Reads the last 7 days, asks the AI to
// make sense of it, saves the result as a thought, and sends it to Telegram.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID')!
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_CHAT_ID = Deno.env.get('OWNER_CHAT_ID') ?? ''

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

const MIN_THOUGHTS = 5

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Telegram is a nice-to-have. A failure here must not lose the digest, which
// is already saved by the time this runs.
async function toTelegram(text: string) {
  if (!TELEGRAM_BOT_TOKEN || !OWNER_CHAT_ID) return
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: OWNER_CHAT_ID, text: text.slice(0, 4000) }),
    })
  } catch (e) {
    console.warn('telegram send failed (ignored):', String(e))
  }
}

Deno.serve(async () => {
  try {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const { data: thoughts, error } = await db
      .from('thoughts')
      .select('content, summary, category, tags, created_at')
      .eq('user_id', OWNER_USER_ID)
      .gte('created_at', since)
      .neq('category', 'digest')      // never summarise your own summaries
      .order('created_at', { ascending: true })

    if (error) return json({ error: error.message }, 500)

    if (!thoughts || thoughts.length < MIN_THOUGHTS) {
      console.log(`only ${thoughts?.length ?? 0} thoughts this week - skipping`)
      return json({ skipped: true, count: thoughts?.length ?? 0 })
    }

    // Send summaries where enrichment produced one, and a short excerpt where
    // it did not. Sending full transcripts would cost 50x more for a worse
    // answer - the model would drown in detail.
    const lines = thoughts.map((t) => {
      const body = t.summary ?? String(t.content ?? '').replace(/\s+/g, ' ').slice(0, 300)
      const tags = Array.isArray(t.tags) && t.tags.length ? ` [${t.tags.join(', ')}]` : ''
      return `- (${t.category ?? 'uncategorised'})${tags} ${body}`
    })

    const byCategory: Record<string, number> = {}
    for (const t of thoughts) {
      const c = t.category ?? 'uncategorised'
      byCategory[c] = (byCategory[c] ?? 0) + 1
    }

    const prompt =
      `Here is everything one person captured into their personal knowledge base ` +
      `over the last 7 days (${thoughts.length} items).\n\n` +
      `Counts by category: ${JSON.stringify(byCategory)}\n\n` +
      `${lines.join('\n')}\n\n` +
      `Write them a short weekly digest with three parts:\n` +
      `1. What they were learning about - group related items, do not just list them\n` +
      `2. Themes - anything that came up more than once, especially across different sources\n` +
      `3. One question they seem to be circling but have not answered yet\n\n` +
      `Write to them directly as "you". No preamble, no headers beyond those three parts. ` +
      `Be specific and concrete - refer to actual things they captured.`

    const res = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        prompt,
        systemPrompt:
          'You write weekly reflections for someone about their own notes. ' +
          'Concrete and specific, never generic encouragement.',
        maxTokens: 1500,
        userId: OWNER_USER_ID,
        source: 'weekly-digest',
      }),
    })

    if (!res.ok) {
      const detail = await res.text()
      console.error('call-llm failed:', res.status, detail.slice(0, 300))
      return json({ error: 'llm call failed' }, 500)
    }

    const { text, error: llmError } = await res.json()
    if (llmError || !text) return json({ error: llmError ?? 'empty response' }, 500)

    const dateLabel = new Date().toISOString().slice(0, 10)
    const digest = `Weekly digest - ${dateLabel}\n(${thoughts.length} captures)\n\n${text}`

    // enriched_at is set so the trigger leaves this row alone and category
    // stays 'digest'.
    const { error: insertError } = await db.from('thoughts').insert({
      user_id: OWNER_USER_ID,
      content: digest,
      category: 'digest',
      summary: `Weekly digest covering ${thoughts.length} captures`,
      tags: ['digest', 'weekly'],
      enriched_at: new Date().toISOString(),
      metadata: { capture: 'weekly-digest', items: thoughts.length },
    })

    if (insertError) return json({ error: insertError.message }, 500)

    await toTelegram(digest)

    return json({ ok: true, items: thoughts.length })
  } catch (e) {
    console.error('weekly-digest error:', String(e))
    return json({ error: String(e) }, 500)
  }
})
