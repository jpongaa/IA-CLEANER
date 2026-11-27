// Configurações persistidas. A chave da API é criptografada com o cofre do Windows (DPAPI via
// Electron safeStorage), injetado pelo main com setSecretCipher(). Sem cifra (testes), usa só ANTHROPIC_API_KEY.
import * as z from 'zod/v4'
import { AI_MODELS } from '@shared/types/ai'
import { DEFAULT_SETTINGS, type AppSettings, type SettingsPatch } from '@shared/types/settings'
import { readJson, writeJson } from './store'

type PublicOnly = 'apiKeySet' | 'apiKeyUnreadable' | 'apiKeyProblem'

interface StoredSettings extends Omit<AppSettings, PublicOnly> {
  /** base64 do valor cifrado */
  apiKeyEnc?: string
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
  model: z.enum(AI_MODELS.map((m) => m.id) as [AppSettings['model'], ...AppSettings['model'][]]),
  effort: z.enum(['low', 'medium', 'high']),
  webSearch: z.boolean(),
  anonymizePaths: z.boolean(),
  deleteMode: z.enum(['recycle', 'permanent']),
  scanExclusions: z.array(z.string().trim().min(1).max(1024)).max(500)
}
const PatchSchema = z.strictObject(FIELDS).partial()

const FIELD_LABEL: Record<string, string> = {
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
  return out
}

export function setSecretCipher(c: SecretCipher | null): void {
  cipher = c
  decryptCache = null
}

async function load(): Promise<StoredSettings> {
  if (!cache) {
    const { apiKeySet: _ignored, ...defaults } = DEFAULT_SETTINGS
    cache = { ...defaults, ...sanitizeStored(await readJson<unknown>(FILE, {})) }
  }
  return cache
}

// ---------- Chave da API: está realmente utilizável? ----------
let decryptCache: { enc: string; key: string | null; problem: string | null } | null = null

const PROBLEM_NO_CIPHER =
  'A criptografia do Windows não está disponível agora, então a chave salva não pode ser lida. Cole a chave novamente ou reinicie o app.'
const PROBLEM_UNREADABLE =
  'A chave salva não pode ser lida neste usuário/PC (ela foi salva em outra conta ou PC, ou o cofre do Windows foi redefinido). Cole a chave novamente.'

/** Decifra uma vez por valor cifrado (DPAPI) e guarda o resultado. */
function storedKeyStatus(s: StoredSettings): { key: string | null; problem: string | null } {
  if (!s.apiKeyEnc) return { key: null, problem: null }
  if (!cipher) return { key: null, problem: PROBLEM_NO_CIPHER }
  if (decryptCache?.enc !== s.apiKeyEnc) {
    let key: string | null = null
    try {
      key = cipher.decrypt(s.apiKeyEnc).trim() || null
    } catch {
      key = null
    }
    decryptCache = { enc: s.apiKeyEnc, key, problem: key ? null : PROBLEM_UNREADABLE }
  }
  return { key: decryptCache.key, problem: decryptCache.problem }
}

function toPublic(s: StoredSettings): AppSettings {
  const { apiKeyEnc, ...rest } = s
  const { key, problem } = storedKeyStatus(s)
  const pub: AppSettings = { ...rest, apiKeySet: Boolean(apiKeyEnc) && key !== null }
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
  const next: StoredSettings = { ...s }
  if (!trimmed) {
    delete next.apiKeyEnc
  } else {
    if (!cipher) throw new Error('Criptografia indisponível para salvar a chave.')
    next.apiKeyEnc = cipher.encrypt(trimmed)
  }
  await writeJson(FILE, next)
  cache = next
  return toPublic(next)
}

/** Se há uma chave salva que não pode ser usada aqui, o motivo (PT-BR); senão null. */
export async function getApiKeyProblem(): Promise<string | null> {
  return storedKeyStatus(await load()).problem
}

/** Chave da API: a salva no app tem prioridade; senão ANTHROPIC_API_KEY. */
export async function getApiKey(): Promise<{ key: string; source: 'settings' | 'env' } | null> {
  const { key } = storedKeyStatus(await load())
  if (key) return { key, source: 'settings' }
  const env = process.env.ANTHROPIC_API_KEY?.trim()
  return env ? { key: env, source: 'env' } : null
}

/** Só testes: esquece o cache (relê settings.json no próximo acesso). */
export function resetSettingsCacheForTests(): void {
  cache = null
  decryptCache = null
}
