// Configurações persistidas. A chave da API é criptografada com o cofre do Windows (DPAPI via
// Electron safeStorage), injetado pelo main com setSecretCipher(). Sem cifra (testes), usa só ANTHROPIC_API_KEY.
import * as z from 'zod/v4'
import { AI_MODELS, AI_PROVIDERS, providerInfo } from '@shared/types/ai'
import { DEFAULT_SETTINGS, type AppSettings, type SettingsPatch } from '@shared/types/settings'
import { readJson, writeJson } from './store'

type PublicOnly = 'apiKeySet' | 'apiKeyUnreadable' | 'apiKeyProblem'

interface StoredSettings extends Omit<AppSettings, PublicOnly> {
  /** base64 do valor cifrado (chave da Anthropic) */
  apiKeyEnc?: string
  /** Chaves cifradas dos outros provedores (id do provedor -> base64) */
  providerKeysEnc?: Record<string, string>
}

/** Endereço do provedor 'custom': https, ou http só em localhost (IA local). null = ok. */
export function customBaseUrlProblem(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return 'endereço inválido'
  }
  if (u.protocol === 'https:') return null
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname.toLowerCase())) return null
  return 'use https:// (ou http:// só para IA local em localhost)'
}

export interface SecretCipher {
  encrypt(plain: string): string
  decrypt(enc: string): string
}

const FILE = 'settings.json'
let cipher: SecretCipher | null = null
let cache: StoredSettings | null = null

/** Campos que a interface pode alterar, com tipos/valores permitidos. Qualquer outro campo é recusado. */
const FIELDS = {
  language: z.enum(['auto', 'pt-BR', 'en', 'es', 'zh-CN']),
  provider: z.enum(AI_PROVIDERS.map((p) => p.id) as [AppSettings['provider'], ...AppSettings['provider'][]]),
  providerModel: z.string().trim().max(200),
  customBaseUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => !customBaseUrlProblem(v)),
  model: z.enum(AI_MODELS.map((m) => m.id) as [AppSettings['model'], ...AppSettings['model'][]]),
  effort: z.enum(['low', 'medium', 'high']),
  webSearch: z.boolean(),
  anonymizePaths: z.boolean(),
  deleteMode: z.enum(['recycle', 'permanent']),
  scanExclusions: z.array(z.string().trim().min(1).max(1024)).max(500)
}
const PatchSchema = z.strictObject(FIELDS).partial()

const FIELD_LABEL: Record<string, string> = {
  language: 'idioma',
  provider: 'provedor da IA',
  providerModel: 'modelo do provedor',
  customBaseUrl: 'endereço da API (https://, ou http:// só em localhost)',
  model: 'modelo',
  effort: 'esforço',
  webSearch: 'pesquisa na web',
  anonymizePaths: 'anonimizar caminhos',
  deleteMode: 'modo de exclusão',
  scanExclusions: 'pastas ignoradas'
}

/** Valida um patch vindo da interface (lança Error em PT-BR; nada é gravado). */
export function validateSettingsPatch(patch: unknown): SettingsPatch {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Configuração inválida: esperado um objeto.')
  const res = PatchSchema.safeParse(patch)
  if (!res.success) {
    const msgs = res.error.issues.map((i) => {
      if (i.code === 'unrecognized_keys') return `campo não permitido: ${i.keys.join(', ')}`
      const key = String(i.path[0] ?? '')
      return `valor inválido para "${FIELD_LABEL[key] ?? key}"`
    })
    throw new Error('Configuração inválida: ' + [...new Set(msgs)].join('; ') + '. Nada foi alterado.')
  }
  // Campos presentes com undefined não apagam o valor atual.
  return Object.fromEntries(Object.entries(res.data).filter(([, v]) => v !== undefined)) as SettingsPatch
}

/** Valores do disco que não passam na validação (arquivo antigo/corrompido) voltam ao padrão, campo a campo. */
function sanitizeStored(raw: unknown): Partial<StoredSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const src = raw as Record<string, unknown>
  const out: Partial<StoredSettings> = {}
  for (const [key, schema] of Object.entries(FIELDS)) {
    if (!(key in src)) continue
    const r = (schema as z.ZodType).safeParse(src[key])
    if (r.success) (out as Record<string, unknown>)[key] = r.data
  }
  if (typeof src.apiKeyEnc === 'string' && src.apiKeyEnc) out.apiKeyEnc = src.apiKeyEnc
  if (src.providerKeysEnc && typeof src.providerKeysEnc === 'object' && !Array.isArray(src.providerKeysEnc)) {
    const keys = Object.entries(src.providerKeysEnc as Record<string, unknown>).filter(
      (e): e is [string, string] => AI_PROVIDERS.some((p) => p.id === e[0] && p.id !== 'anthropic') && typeof e[1] === 'string' && e[1].length > 0
    )
    if (keys.length) out.providerKeysEnc = Object.fromEntries(keys)
  }
  return out
}

export function setSecretCipher(c: SecretCipher | null): void {
  cipher = c
  decryptCache = null
}

async function load(): Promise<StoredSettings> {
  if (!cache) {
    const { apiKeySet: _ignored, ...defaults } = DEFAULT_SETTINGS
    cache = {
      ...defaults,
      ...sanitizeStored(await readJson<unknown>(FILE, {}))
    }
  }
  return cache
}

// ---------- Chave da API: está realmente utilizável? ----------
let decryptCache: {
  enc: string
  key: string | null
  problem: string | null
} | null = null

const PROBLEM_NO_CIPHER =
  'A criptografia do Windows não está disponível agora, então a chave salva não pode ser lida. Cole a chave novamente ou reinicie o app.'
const PROBLEM_UNREADABLE =
  'A chave salva não pode ser lida neste usuário/PC (ela foi salva em outra conta ou PC, ou o cofre do Windows foi redefinido). Cole a chave novamente.'

/** Chave cifrada do provedor escolhido. */
function encOf(s: StoredSettings): string | undefined {
  return s.provider === 'anthropic' ? s.apiKeyEnc : s.providerKeysEnc?.[s.provider]
}

/** Decifra uma vez por valor cifrado (DPAPI) e guarda o resultado. */
function storedKeyStatus(s: StoredSettings): {
  key: string | null
  problem: string | null
} {
  const enc = encOf(s)
  if (!enc) return { key: null, problem: null }
  if (!cipher) return { key: null, problem: PROBLEM_NO_CIPHER }
  if (decryptCache?.enc !== enc) {
    let key: string | null = null
    try {
      key = cipher.decrypt(enc).trim() || null
    } catch {
      key = null
    }
    decryptCache = { enc, key, problem: key ? null : PROBLEM_UNREADABLE }
  }
  return { key: decryptCache.key, problem: decryptCache.problem }
}

function toPublic(s: StoredSettings): AppSettings {
  const { apiKeyEnc: _a, providerKeysEnc: _p, ...rest } = s
  const { key, problem } = storedKeyStatus(s)
  const pub: AppSettings = {
    ...rest,
    apiKeySet: Boolean(encOf(s)) && key !== null
  }
  if (problem) {
    pub.apiKeyUnreadable = true
    pub.apiKeyProblem = problem
  }
  return pub
}

export async function getSettings(): Promise<AppSettings> {
  return toPublic(await load())
}

/** Altera configurações. O patch é validado (campos desconhecidos, apiKeyEnc, tipos/enum errados = erro). */
export async function updateSettings(patch: unknown): Promise<AppSettings> {
  const clean = validateSettingsPatch(patch)
  const s = await load()
  const next = { ...s, ...clean }
  await writeJson(FILE, next)
  cache = next
  return toPublic(next)
}

export async function setApiKey(key: string | null): Promise<AppSettings> {
  if (key !== null && typeof key !== 'string') throw new Error('Chave inválida.')
  const s = await load()
  const trimmed = key?.trim()
  const next: StoredSettings = {
    ...s,
    providerKeysEnc: { ...s.providerKeysEnc }
  }
  if (trimmed && !cipher) throw new Error('Criptografia indisponível para salvar a chave.')
  const enc = trimmed ? cipher!.encrypt(trimmed) : undefined
  // A chave vale só para o provedor escolhido agora; as dos outros continuam guardadas.
  if (s.provider === 'anthropic') {
    if (enc) next.apiKeyEnc = enc
    else delete next.apiKeyEnc
  } else if (enc) next.providerKeysEnc![s.provider] = enc
  else delete next.providerKeysEnc![s.provider]
  if (!Object.keys(next.providerKeysEnc!).length) delete next.providerKeysEnc
  await writeJson(FILE, next)
  cache = next
  return toPublic(next)
}

/** Se há uma chave salva que não pode ser usada aqui, o motivo (PT-BR); senão null. */
export async function getApiKeyProblem(): Promise<string | null> {
  return storedKeyStatus(await load()).problem
}

/** Chave do provedor escolhido: a salva no app tem prioridade; senão a variável de ambiente dele (ex.: ANTHROPIC_API_KEY). */
export async function getApiKey(): Promise<{
  key: string
  source: 'settings' | 'env'
} | null> {
  const s = await load()
  const { key } = storedKeyStatus(s)
  if (key) return { key, source: 'settings' }
  const env = process.env[providerInfo(s.provider).envVar]?.trim()
  return env ? { key: env, source: 'env' } : null
}

/** Só testes: esquece o cache (relê settings.json no próximo acesso). */
export function resetSettingsCacheForTests(): void {
  cache = null
  decryptCache = null
}
