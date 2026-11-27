// Teste offline da análise item a item ("Tudo que dá para apagar"): IA FALSA em 127.0.0.1, perfil temporário.
// Confere: só a rota local, ids inventados descartados, regra "manter" do app vence a IA, caminhos anonimizados.
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createAiApi } from '../../src/main/ai'
import { setAiTransport } from '../../src/main/ai/client'
import { dataDir, setAppPaths } from '../../src/main/core/paths'
import { getSettings, resetSettingsCacheForTests } from '../../src/main/core/settings'

export async function run(): Promise<void> {
  const profile = path.join(os.tmpdir(), `iacleaner-ai-items-${process.pid}`)
  mkdirSync(profile, { recursive: true })
  const prevUserData = dataDir()
  const savedKey = process.env.ANTHROPIC_API_KEY
  const bodies: { url: string; text: string }[] = []
  const srv = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      bodies.push({ url: req.url ?? '', text: raw })
      const reply = {
        items: [
          { id: 'i1', verdict: 'apagar', whatIsIt: 'cache de shaders da NVIDIA', explanation: 'O driver recria sozinho.' },
          { id: 'i2', verdict: 'apagar', whatIsIt: 'cache do Windows Installer', explanation: 'Teste: a IA errou de propósito.' },
          { id: 'inventado', verdict: 'apagar', whatIsIt: 'x', explanation: 'x' }
        ]
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'msg_fake_items',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: JSON.stringify(reply) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 2000, output_tokens: 300 }
        })
      )
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  try {
    setAppPaths({ userData: profile })
    resetSettingsCacheForTests()
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-chave-falsa-de-teste-iacleaner-000000000000'
    setAiTransport({ baseURL: `http://127.0.0.1:${(srv.address() as { port: number }).port}` })
    const home = os.homedir()
    const rep = await createAiApi().explainItems([
      { id: 'i1', title: 'Cache de shaders da NVIDIA', paths: [path.join(home, 'AppData', 'Local', 'NVIDIA', 'DXCache')], bytes: 9e9, source: 'Limpeza', appVerdict: 'safe' },
      { id: 'i2', title: 'Cache do Windows Installer', paths: ['C:\\Windows\\Installer'], bytes: 9.8e9, source: 'Limpeza', appVerdict: 'keep' }
    ])
    assert.ok(bodies.length >= 1 && bodies.every((b) => b.url.startsWith('/v1/messages')), 'só a rota de mensagens, no servidor local')
    assert.match(bodies[0].text, /\[i1\]/, 'item enviado com o id entre colchetes')
    if ((await getSettings()).anonymizePaths) {
      assert.ok(!bodies[0].text.toLowerCase().includes(JSON.stringify(home).slice(1, -1).toLowerCase()), 'pasta do usuário não vai para a IA')
    }
    const byId = new Map(rep.items.map((x) => [x.id, x]))
    assert.equal(rep.items.length, 2, 'id inventado descartado')
    assert.equal(byId.get('i1')?.verdict, 'apagar')
    assert.equal(byId.get('i2')?.verdict, 'manter', 'regra "manter" do app vence a IA')
    assert.equal(byId.get('i1')?.whatIsIt, 'cache de shaders da NVIDIA')
    console.log(`explainItems offline: ${rep.items.length} itens · custo simulado ${rep.usage.costUsd.toFixed(4)} US$ · OK`)
  } finally {
    setAiTransport({})
    srv.close()
    if (savedKey) process.env.ANTHROPIC_API_KEY = savedKey
    else delete process.env.ANTHROPIC_API_KEY
    setAppPaths({ userData: prevUserData })
    resetSettingsCacheForTests()
    rmSync(profile, { recursive: true, force: true })
  }
}
