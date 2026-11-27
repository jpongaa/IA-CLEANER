// Teste offline dos provedores "compatíveis com OpenAI" (ChatGPT, Gemini, Grok, IA local...): servidor FALSO em
// 127.0.0.1, perfil temporário. Confere lista de modelos, teste de conexão, JSON com fallback de formato, regra
// "manter" do app, custo desconhecido, chat em streaming, chave opcional e validação do endereço.
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createAiApi } from '../../src/main/ai'
import { setAiTransport } from '../../src/main/ai/client'
import { setEventSink } from '../../src/main/core/events'
import { dataDir, setAppPaths } from '../../src/main/core/paths'
import { resetSettingsCacheForTests, updateSettings } from '../../src/main/core/settings'

export async function run(): Promise<void> {
  const profile = path.join(os.tmpdir(), `iacleaner-ai-compat-${process.pid}`)
  mkdirSync(profile, { recursive: true })
  const prevUserData = dataDir()
  const savedKey = process.env.OPENAI_COMPAT_API_KEY
  delete process.env.OPENAI_COMPAT_API_KEY
  const seen: { method: string; url: string; auth?: string; body: Record<string, unknown> }[] = []
  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body })
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'modelo-teste' }, { id: 'text-embedding-3-small' }] }))
        return
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        for (const t of ['Olá! ', 'Sobrou a pasta do **Foxhole**.']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        res.end('data: [DONE]\n\n')
        return
      }
      // Recusa o JSON Schema estrito (como alguns provedores): o app deve cair para json_object.
      const fmt = (body.response_format as { type?: string } | undefined)?.type
      if (fmt === 'json_schema') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'response_format json_schema not supported' } }))
        return
      }
      const reply = {
        items: [
          { id: 'i1', verdict: 'apagar', whatIsIt: 'cache de shaders', explanation: 'Recriado sozinho.' },
          { id: 'i2', verdict: 'apagar', whatIsIt: 'cache do Windows Installer', explanation: 'Errado de propósito.' }
        ]
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: `<think>pensando {x}</think>\n${JSON.stringify(reply)}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1500, completion_tokens: 200 }
        })
      )
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  const port = (srv.address() as { port: number }).port
  const events: { event: string; payload: unknown }[] = []
  try {
    setAppPaths({ userData: profile })
    resetSettingsCacheForTests()
    setAiTransport({})
    setEventSink((event, payload) => events.push({ event, payload }))

    await assert.rejects(updateSettings({ customBaseUrl: 'http://exemplo.com/v1' }), /endereço da API/, 'http fora de localhost é recusado')
    await updateSettings({ provider: 'custom', customBaseUrl: `http://127.0.0.1:${port}/v1`, providerModel: '' })
    const ai = createAiApi()

    const models = await ai.listModels()
    assert.deepEqual(models, ['modelo-teste'], 'lista só modelos de conversa')
    const status0 = await ai.getStatus()
    assert.equal(status0.configured, false, 'sem modelo escolhido ainda não está configurado')

    await updateSettings({ providerModel: 'modelo-teste' })
    const status = await ai.getStatus()
    assert.equal(status.configured, true)
    assert.equal(status.provider, 'custom')
    assert.equal(status.webSearch, false, 'busca na web só no Claude')

    const test = await ai.testConnection()
    assert.ok(test.ok, test.message)
    assert.match(test.message, /modelo-teste/)

    const rep = await ai.explainItems([
      { id: 'i1', title: 'Cache de shaders', paths: ['C:\\x\\DXCache'], bytes: 9e9, source: 'Limpeza', appVerdict: 'safe' },
      { id: 'i2', title: 'Cache do Windows Installer', paths: ['C:\\Windows\\Installer'], bytes: 9.8e9, source: 'Limpeza', appVerdict: 'keep' }
    ])
    const byId = new Map(rep.items.map((x) => [x.id, x]))
    assert.equal(byId.get('i1')?.verdict, 'apagar')
    assert.equal(byId.get('i2')?.verdict, 'manter', 'regra "manter" do app vence a IA')
    assert.equal(rep.usage.costUnknown, true, 'custo desconhecido fora do Claude')
    assert.equal(rep.usedWebSearch, false)
    const posts = seen.filter((s) => s.method === 'POST' && !s.body.stream)
    assert.deepEqual(
      posts.map((p) => (p.body.response_format as { type?: string } | undefined)?.type ?? 'none'),
      ['json_schema', 'json_object'],
      'caiu de json_schema para json_object'
    )
    assert.ok(seen.every((s) => !s.auth), 'sem chave: nenhum cabeçalho Authorization')

    process.env.OPENAI_COMPAT_API_KEY = 'chave-falsa-de-teste-123'
    const { streamId } = await ai.chat([{ role: 'user', content: 'o que sobrou?' }])
    for (let i = 0; i < 100 && !events.some((e) => e.event === 'ai:chatDone'); i++) await new Promise((r) => setTimeout(r, 50))
    const text = events
      .filter((e) => e.event === 'ai:chatDelta' && (e.payload as { streamId: string }).streamId === streamId)
      .map((e) => (e.payload as { delta: string }).delta)
      .join('')
    const done = events.find((e) => e.event === 'ai:chatDone')?.payload as { error?: string } | undefined
    assert.ok(done && !done.error, `chat sem erro (${done?.error})`)
    assert.equal(text, 'Olá! Sobrou a pasta do **Foxhole**.')
    assert.equal(seen[seen.length - 1].auth, 'Bearer chave-falsa-de-teste-123', 'chave da variável de ambiente vai no Authorization')
    assert.ok(seen.every((s) => s.url.startsWith('/v1/')), 'só a API local')
    console.log(`provedor compatível offline: modelos=${models.join(',')} · itens=${rep.items.length} · chat="${text}" · OK`)
  } finally {
    setEventSink(() => undefined)
    srv.close()
    if (savedKey) process.env.OPENAI_COMPAT_API_KEY = savedKey
    else delete process.env.OPENAI_COMPAT_API_KEY
    setAppPaths({ userData: prevUserData })
    resetSettingsCacheForTests()
    rmSync(profile, { recursive: true, force: true })
  }
}
