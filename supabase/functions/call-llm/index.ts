// To switch providers, change LLM_PROVIDER in Supabase secrets and add the new
// provider's API key. No other code changes needed.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const LLM_PROVIDER = Deno.env.get('LLM_PROVIDER') ?? 'anthropic'
const LLM_MODEL = Deno.env.get('LLM_MODEL') ?? 'claude-haiku-4-5-20251001'
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''

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

// Published prices per million tokens, used only to estimate what a call cost.
// An unknown model logs 0 rather than guessing - a wrong number is worse than
// no number.
const PRICES: Record<string, { in: number; out: number }> = {
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-opus-5-5': { in: 4, out: 20 },
}

function estimateCost(model: string, inTokens: number, outTokens: number): number {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k))
  if (!key) return 0
  const p = PRICES[key]
  return (inTokens / 1_000_000) * p.in + (outTokens / 1_000_000) * p.out
}

interface LlmResult {
  text: string
  model: string
  inTokens: number
  outTokens: number
}

async function callAnthropic(
  prompt: string,
  systemPrompt: string | undefined,
  model: string,
  maxTokens: number,
): Promise<LlmResult> {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`Anthropic HTTP ${res.status}: ${detail.slice(0, 400)}`)
  }

  const data = await res.json()
  const text = (data?.content ?? [])
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text)
    .join('')
    .trim()

  return {
    text,
    model: data?.model ?? model,
    inTokens: data?.usage?.input_tokens ?? 0,
    outTokens: data?.usage?.output_tokens ?? 0,
  }
}

// Adding a provider means adding a branch here and a key in secrets. Nothing
// that calls this function changes.
async function callProvider(
  provider: string,
  prompt: string,
  systemPrompt: string | undefined,
  model: string,
  maxTokens: number,
): Promise<LlmResult> {
  switch (provider) {
    case 'anthropic':
      return await callAnthropic(prompt, systemPrompt, model, maxTokens)
    default:
      throw new Error(
        `LLM_PROVIDER "${provider}" is not implemented yet. Add a branch in ` +
        `callProvider() and set that provider's API key in Supabase secrets.`,
      )
  }
}

// Recording what a call cost must NEVER break the call itself. The AI already
// answered; the caller already has what it needed. A logging failure is a shrug.
async function logUsage(
  userId: string | undefined,
  result: LlmResult,
  source: string | undefined,
) {
  if (!userId) return
  try {
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    await db.from('llm_usage').insert({
      user_id: userId,
      kind: 'chat',
      model: result.model,
      source: source ?? 'unknown',
      prompt_tokens: result.inTokens,
      completion_tokens: result.outTokens,
      cost_usd: estimateCost(result.model, result.inTokens, result.outTokens),
    })
  } catch (e) {
    console.warn('llm_usage insert failed (ignored):', String(e))
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const { prompt, systemPrompt, model, maxTokens, userId, source } = await req.json()

    if (!prompt || typeof prompt !== 'string') {
      return json({ error: 'A prompt is required' }, 400)
    }

    const result = await callProvider(
      LLM_PROVIDER,
      prompt,
      systemPrompt,
      model || LLM_MODEL,
      Number(maxTokens) || 1024,
    )

    // Deliberately not awaited - the caller gets its answer without waiting
    // for a bookkeeping write.
    logUsage(userId, result, source)

    return json({
      text: result.text,
      model: result.model,
      usage: { input_tokens: result.inTokens, output_tokens: result.outTokens },
    })
  } catch (e) {
    console.error('call-llm error:', String(e))
    return json({ error: String(e) }, 500)
  }
})
