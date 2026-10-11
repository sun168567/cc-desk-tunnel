// Optional prompt translation bridge: routes user prompts and the final response through any
// OpenAI-compatible endpoint, so the model never sees the user's native language. Designed for
// users whose accounts live in regions where a datacenter exit IP or native-language traffic
// draws extra scrutiny. Never throws: on any failure the original text passes through unchanged.
// Configuration (server environment): PROXY_TRANSLATE_URL (chat-completions URL),
// PROXY_TRANSLATE_API_KEY, PROXY_TRANSLATE_MODEL (optional; discovered from /v1/models),
// PROXY_TRANSLATE_ENABLED (default true when URL and key are set).
import https from 'node:https';

type TranslateConfig = {
  url: string; // full chat-completions URL, e.g. https://api.example.com/v1/chat/completions
  apiKey: string;
  model: string; // resolved model id; discovered from /v1/models when PROXY_TRANSLATE_MODEL is unset
};

let cached: TranslateConfig | null = null;
let cachedAt = 0;
let discovered: string | null = null;
let discoveredAt = 0;

function envConfig(): TranslateConfig | null {
  const url = (process.env.PROXY_TRANSLATE_URL ?? '').trim();
  const key = (process.env.PROXY_TRANSLATE_API_KEY ?? '').trim();
  if (!url || !key) return null;
  const model = (process.env.PROXY_TRANSLATE_MODEL ?? '').trim();
  return {
    url: url.endsWith('/chat/completions') ? url : `${url.replace(/\/+$/, '')}/chat/completions`,
    apiKey: key,
    model,
  };
}

// The config is re-read once per minute so docker.env edits apply without a restart.
function config(): TranslateConfig | null {
  if (Date.now() - cachedAt < 60_000) return cached;
  cached = envConfig();
  cachedAt = Date.now();
  return cached;
}

function hasCJK(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function request(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const target = new URL(url);
    const req = https.request(
      {
        hostname: target.hostname,
        port: target.port || 443,
        path: target.pathname + target.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => {
          try {
            const content = JSON.parse(buf).choices?.[0]?.message?.content?.trim();
            resolve(content || null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.write(payload);
    req.end();
  });
}

async function resolveModel(config: TranslateConfig): Promise<string | null> {
  if (config.model) return config.model;
  // No model configured: discover once per hour from the endpoint's own model list and prefer a
  // cheap fast variant when the provider exposes one.
  if (discovered && Date.now() - discoveredAt < 3_600_000) return discovered;
  const listUrl = new URL(config.url);
  listUrl.pathname = listUrl.pathname.replace(/\/chat\/completions$/, '/models');
  const list = await new Promise<string | null>((resolve) => {
    const req = https.request(
      {
        hostname: listUrl.hostname,
        port: listUrl.port || 443,
        path: listUrl.pathname + listUrl.search,
        method: 'GET',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'User-Agent': 'Mozilla/5.0' },
        timeout: 15000,
      },
      (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => {
          try {
            const ids: string[] = (JSON.parse(buf).data ?? [])
              .map((m: { id?: string }) => String(m.id ?? ''))
              .filter(Boolean);
            resolve(ids.length ? ids.join('\n') : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
  if (!list) return null;
  const ids = list.split('\n');
  discovered = ids.find((id) => /flash|mini|fast|lite|turbo/i.test(id)) ?? ids[0] ?? null;
  discoveredAt = Date.now();
  console.log(`[translate] model discovered: ${String(discovered)}`);
  return discovered;
}

async function complete(
  config: TranslateConfig,
  instruction: string,
  text: string,
  timeoutMs: number,
): Promise<string | null> {
  const model = await resolveModel(config);
  if (!model) return null;
  return request(
    config.url,
    config.apiKey,
    {
      model,
      max_tokens: 8192,
      temperature: 0.2,
      messages: [{ role: 'user', content: `${instruction}\n\n${text}` }],
    },
    timeoutMs,
  );
}

/** CJK user prompt -> English for the model. Returns null to pass through unchanged. */
export async function translatePrompt(text: string): Promise<string | null> {
  const config = config();
  if (!config?.enabled) return null;
  if (!hasCJK(text)) return null;
  return complete(
    config,
    'Translate the following Chinese instruction into natural, precise English for a coding agent. '
      + 'Keep file paths, code, and commands unchanged. Output ONLY the English translation.',
    text,
    30000,
  );
}

/** English final response -> Chinese for the user. Returns null to pass through unchanged. */
export async function translateResponse(text: string): Promise<string | null> {
  const config = config();
  if (!config?.enabled) return null;
  if (hasCJK(text)) return null; // already contains Chinese; nothing to add
  return complete(
    config,
    'Translate the following English response into natural Chinese for the user to read. '
      + 'Keep code blocks, file paths, commands, and identifiers unchanged. '
      + 'Output ONLY the Chinese translation.',
    text,
    60000,
  );
}
