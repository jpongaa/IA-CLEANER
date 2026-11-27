// Esquemas (zod v4) das respostas da IA + conversão para JSON Schema aceito pela saída estruturada.
// Os campos usam .catch() para o parse ser tolerante (o validador depois corrige/limita tudo).
import * as z from 'zod/v4'
import type { BetaJSONOutputFormat } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import type { FindingActionKind } from '@shared/types/discover'

const str = (description: string) => z.string().describe(description).catch('')
const strList = (description: string) => z.array(z.string()).describe(description).catch([])

const VERDICTS = ['safe', 'review', 'keep'] as const
const RISKS = ['low', 'medium', 'high'] as const
const IMPACTS = ['high', 'medium', 'low'] as const
export const ACTION_KINDS = [
  'clean_target',
  'uninstall_game',
  'uninstall_program',
  'move_game',
  'delete_files',
  'review_files',
  'apply_optimization',
  'disable_startup',
  'update_driver',
  'resolve_finding',
  'repair_issue',
  'manual',
  'none'
] as const

/** Ações de um achado da Busca Profunda (mesma lista de FindingActionKind). */
export const FINDING_ACTION_KINDS = [
  'recycle',
  'deleteLeftovers',
  'runUninstaller',
  'forceRemove',
  'removeBrokenEntry',
  'disableStartup',
  'openFolder',
  'openSettings',
  'openLauncher',
  'learnMore'
] as const satisfies readonly FindingActionKind[]

export const RecommendationOut = z.object({
  title: str('Título curto (até ~80 caracteres), PT-BR'),
  explanation: str('Por que, e o que acontece se fizer (1 a 4 frases), PT-BR'),
  verdict: z.enum(VERDICTS).describe('safe = pode apagar; review = revisar antes; keep = manter').catch('review'),
  risk: z.enum(RISKS).catch('medium'),
  priority: z.number().describe('1 (fazer primeiro) a 5 (menos importante)').catch(3),
  action: z.enum(ACTION_KINDS).catch('manual'),
  targetRefs: strList('Refs dos itens, copiadas exatamente dos dados (sem colchetes)'),
  estimatedBytes: z.number().nullable().describe('Bytes liberados (soma aproximada) ou null').catch(null),
  // Opcional só no tipo TS (respostas antigas/testes sem o campo); no JSON Schema estrito ele é obrigatório (null).
  findingAction: z
    .enum(FINDING_ACTION_KINDS)
    .nullable()
    .catch(null)
    .optional()
    .describe('Só com action "resolve_finding": uma das "ações do app" listadas no achado (found:). Senão null')
})
export type RecommendationOut = z.infer<typeof RecommendationOut>

export const CleanupOut = z.object({
  summary: str('Diagnóstico geral em 2 a 5 frases, PT-BR'),
  criticalPoints: z
    .array(
      z.object({
        title: str('Ponto crítico de espaço'),
        detail: str('Explicação curta'),
        bytes: z.number().nullable().catch(null),
        refs: strList('Refs relacionadas')
      })
    )
    .catch([]),
  recommendations: z.array(RecommendationOut).catch([]),
  keepWarnings: z
    .array(
      z.object({
        title: str('O que parece lixo mas deve ficar'),
        detail: str('Por que manter'),
        refs: strList('Refs relacionadas')
      })
    )
    .catch([])
})
export type CleanupOut = z.infer<typeof CleanupOut>

export const PerformanceOut = z.object({
  healthScore: z.number().describe('0 a 100').catch(50),
  headline: str('Frase curta com o principal motivo da lentidão'),
  summary: str('Resumo em 2 a 5 frases'),
  rootCauses: z
    .array(
      z.object({
        title: str('Causa'),
        evidence: str('Evidência concreta dos dados (números)'),
        impact: z.enum(IMPACTS).catch('medium'),
        actionIds: strList('Ids de ações do catálogo (sem o prefixo action:)'),
        manualSteps: strList('Passos manuais, PT-BR')
      })
    )
    .catch([]),
  quickWins: z.array(RecommendationOut).catch([]),
  upgradeAdvice: z.string().nullable().describe('Conselho de upgrade ou null').catch(null),
  myths: strList('Mitos: o que NÃO acelera o PC neste caso')
})
export type PerformanceOut = z.infer<typeof PerformanceOut>

export const DriversOut = z.object({
  summary: str('Situação geral em 2 a 4 frases'),
  items: z
    .array(
      z.object({
        driverId: str('Id do driver (parte depois de "driver:")'),
        status: z.enum(['up_to_date', 'update_available', 'unknown', 'problem']).catch('unknown'),
        latestVersion: z.string().nullable().describe('Versão mais recente confirmada, ou null').catch(null),
        recommendation: str('O que fazer, 1 a 3 frases'),
        officialUrl: z.string().nullable().describe('URL https oficial do fabricante/Microsoft, ou null').catch(null),
        sources: strList('URLs oficiais consultadas')
      })
    )
    .catch([])
})
export type DriversOut = z.infer<typeof DriversOut>

export const ItemsOut = z.object({
  items: z
    .array(
      z.object({
        id: str('Id do item, exatamente como veio entre colchetes (ex.: i12)'),
        verdict: z.enum(['apagar', 'manter', 'desconhecido']).catch('desconhecido'),
        whatIsIt: str('O que é, em poucas palavras (ex.: "cache de shaders da NVIDIA")'),
        explanation: str('Por que pode ou não apagar, 1 a 2 frases')
      })
    )
    .catch([])
})
export type ItemsOut = z.infer<typeof ItemsOut>

/** Entrada vinda da interface (fronteira IPC): corta textos longos em vez de recusar a lista inteira. */
const cut = (n: number) => z.string().transform((s) => s.slice(0, n))
export const ItemsIn = z
  .array(
    z.object({
      id: cut(40),
      title: cut(300),
      paths: z.array(cut(400)).transform((a) => a.slice(0, 4)),
      bytes: z.number().nonnegative().catch(0),
      source: cut(40),
      appVerdict: z.enum(['safe', 'review', 'keep']).catch('review'),
      detail: cut(500).optional()
    })
  )
  .max(400)

// ---------------------------------------------------------------- JSON Schema estrito

type Json = Record<string, unknown>

const KEEP_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'description', '$defs', '$ref'])

/**
 * Converte o JSON Schema gerado pelo zod para o subconjunto aceito pela saída estruturada:
 * objetos com additionalProperties:false e todos os campos obrigatórios; sem min/max/default;
 * `type: [x, 'null']` vira anyOf. (O helper do SDK rebaixa `enum` para descrição — aqui o enum é mantido.)
 */
export function toStrictSchema(schema: Json): Json {
  const out: Json = {}
  const type = schema.type
  if (Array.isArray(type)) {
    const variants = type.map((t) => {
      const v: Json = { type: t }
      if (t !== 'null') {
        for (const k of ['enum', 'items', 'properties', 'required']) if (k in schema) v[k] = schema[k]
      }
      return toStrictSchema(v)
    })
    const res: Json = { anyOf: variants }
    if (typeof schema.description === 'string') res.description = schema.description
    return res
  }
  for (const [k, v] of Object.entries(schema)) {
    if (!KEEP_KEYS.has(k)) continue
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v as Json).map(([pk, pv]) => [pk, toStrictSchema(pv as Json)]))
    } else if (k === 'items' && v && typeof v === 'object' && !Array.isArray(v)) {
      out.items = toStrictSchema(v as Json)
    } else if (k === 'anyOf' && Array.isArray(v)) {
      out.anyOf = v.map((x) => toStrictSchema(x as Json))
    } else if (k === '$defs' && v && typeof v === 'object') {
      out.$defs = Object.fromEntries(Object.entries(v as Json).map(([dk, dv]) => [dk, toStrictSchema(dv as Json)]))
    } else {
      out[k] = v
    }
  }
  if (out.type === 'object') {
    out.additionalProperties = false
    out.required = Object.keys((out.properties as Json) ?? {})
  }
  return out
}

/** JSON Schema estrito a partir de um esquema zod. */
export function strictJsonSchema(schema: z.ZodType): Json {
  return toStrictSchema(z.toJSONSchema(schema) as Json)
}

/** output_config.format para a API. */
export function outputFormat(schema: z.ZodType): BetaJSONOutputFormat {
  return { type: 'json_schema', schema: strictJsonSchema(schema) }
}

/** Extrai o último bloco ```json ... ``` (ou o maior objeto {...}) de um texto. */
export function extractJsonBlock(text: string): string | null {
  const fences = [...text.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/gi)].map((m) => m[1].trim()).filter((s) => s.startsWith('{'))
  if (fences.length) return fences[fences.length - 1]
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start >= 0 && end > start ? text.slice(start, end + 1) : null
}

/** JSON.parse + safeParse. Nunca lança. */
export function parseWith<T>(schema: z.ZodType<T>, text: string | null): { ok: true; data: T } | { ok: false; error: string } {
  if (!text) return { ok: false, error: 'resposta vazia' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `JSON inválido: ${(e as Error).message}` }
  }
  const r = schema.safeParse(raw)
  return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error.message.slice(0, 300) }
}
