import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPADATA_KEY = Deno.env.get('SUPADATA_API_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function decodeEntities(input: string): string {
  let s = input
  const pairs: [string, string][] = [
    ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&#39;', "'"], ['&apos;', "'"],
    ['&nbsp;', ' '], ['&rsquo;', '\u2019'], ['&lsquo;', '\u2018'],
    ['&rdquo;', '\u201D'], ['&ldquo;', '\u201C'],
    ['&mdash;', '\u2014'], ['&ndash;', '\u2013'], ['&hellip;', '\u2026'],
    ['&aacute;', '\u00E1'], ['&eacute;', '\u00E9'], ['&iacute;', '\u00ED'],
    ['&oacute;', '\u00F3'], ['&uacute;', '\u00FA'], ['&ntilde;', '\u00F1'],
    ['&uuml;', '\u00FC'], ['&iexcl;', '\u00A1'], ['&iquest;', '\u00BF'],
  ]
  for (const [ent, ch] of pairs) s = s.split(ent).join(ch)
  s = s.replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
  return s.split('&amp;').join('&')
}

interface VideoContent {
  content: string
  hasTranscript: boolean
  source: string
}

function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return m[1]
  }
  return null
}

async function fetchTitle(videoUrl: string, videoId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`,
      { signal: AbortSignal.timeout(8000) },
    )
    if (res.ok) {
      const data = await res.json()
      if (data?.title) return decodeEntities(String(data.title))
    }
  } catch {
    // fall through to the placeholder
  }
  return `Video ${videoId}`
}

// --- ROUTE 1: Supadata -----------------------------------------------------
async function fromSupadata(videoUrl: string): Promise<VideoContent | null> {
  if (!SUPADATA_KEY) return null
  try {
    const res = await fetch(
      `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(videoUrl)}&lang=en`,
      { headers: { 'x-api-key': SUPADATA_KEY }, signal: AbortSignal.timeout(20_000) },
    )
    if (!res.ok) {
      // 402 here almost always means the free monthly quota is spent
      console.log(`[youtube] Supadata HTTP ${res.status} - falling through`)
      return null
    }
    const data = await res.json()
    const segments: Array<{ text?: string }> = data?.content ?? []
    const transcript = segments.map((s) => s.text ?? '').join(' ').replace(/\s+/g, ' ').trim()
    if (!transcript) return null
    console.log(`[youtube] Supadata OK - ${transcript.length} chars`)
    return { content: transcript, hasTranscript: true, source: 'supadata' }
  } catch (err) {
    console.error('[youtube] Supadata error:', String(err))
    return null
  }
}

// --- ROUTES 2 and 3: YouTube's internal app API, then the description ------
async function fromInnertube(videoId: string): Promise<VideoContent | null> {
  const clients = [
    {
      name: 'IOS',
      userAgent: 'com.google.ios.youtube/19.29.1 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      context: {
        clientName: 'IOS', clientVersion: '19.29.1',
        deviceMake: 'Apple', deviceModel: 'iPhone17,2',
        osName: 'iPhone', osVersion: '18.1.0.22B83', hl: 'en', gl: 'US',
      },
    },
    {
      name: 'ANDROID',
      userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
      context: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en', gl: 'US' },
    },
  ]

  let best: any = null

  for (const client of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': client.userAgent },
        body: JSON.stringify({ context: { client: client.context }, videoId }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        console.log(`[youtube] Innertube ${client.name} HTTP ${res.status}`)
        continue
      }
      const result = await res.json()
      const tracks = result?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      if (Array.isArray(tracks) && tracks.length > 0) {
        console.log(`[youtube] Innertube ${client.name}: ${tracks.length} caption tracks`)
        best = result
        break
      }
      // Keep the first response anyway - even with no captions it carries the
      // description, which beats nothing.
      if (!best) best = result
      console.log(`[youtube] Innertube ${client.name}: no caption tracks`)
    } catch (err) {
      console.error(`[youtube] Innertube ${client.name} error:`, String(err))
    }
  }

  if (!best) return null

  try {
    const tracks = best?.captions?.playerCaptionsTracklistRenderer?.captionTracks
    if (Array.isArray(tracks) && tracks.length > 0) {
      // Prefer human-written English, then auto-generated English, then anything
      const track =
        tracks.find((t: any) => t.languageCode === 'en' && t.kind !== 'asr') ??
        tracks.find((t: any) => t.languageCode === 'en') ??
        tracks.find((t: any) => String(t.languageCode ?? '').startsWith('en')) ??
        tracks[0]

      const capRes = await fetch(track.baseUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(12_000),
      })

      if (capRes.ok) {
        const xml = await capRes.text()
        // Caption XML looks like: <text start="1.2" dur="3.4">words here</text>
        const transcript = [...xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
          .map((m) => decodeEntities(m[1]))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (transcript) {
          console.log(`[youtube] Innertube transcript OK - ${transcript.length} chars`)
          return { content: transcript, hasTranscript: true, source: 'innertube' }
        }
      }
    }

    // ROUTE 3 - no captions anywhere. Use the description.
    const details = best?.videoDetails
    const description: string = details?.shortDescription ?? ''
    const keywords: string = (details?.keywords as string[] | undefined)?.join(',
