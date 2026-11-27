// Tradução da interface (sem DOM): o tradutor puro e a saúde dos catálogos (marcadores {0} preservados, cobertura).
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { createTranslator, norm } from '../../src/renderer/src/i18n/translator'

export async function run(): Promise<void> {
  const t = createTranslator({
    Configurações: 'Settings',
    'Pode apagar': 'Safe to delete',
    'Liberado: {0}.': 'Freed: {0}.',
    'Sobrou a pasta do {0} ({1})': '{0} folder left over ({1})',
    '{0} itens': '{0} items',
    '· sem Secure Boot': '· no Secure Boot',
    '{0} {1}': 'não deve virar padrão'
  })
  assert.equal(t('Configurações'), 'Settings')
  assert.equal(t('Liberado: 3,2 GB.'), 'Freed: 3,2 GB.')
  assert.equal(t('Sobrou a pasta do Foxhole (1,2 GB)'), 'Foxhole folder left over (1,2 GB)', 'marcadores reordenados')
  assert.equal(t('12 itens'), '12 items')
  assert.equal(t('Pode apagar · 3 GB'), 'Safe to delete · 3 GB', 'listas com " · ": traduz cada pedaço')
  assert.equal(t('Liberado: 12 itens.'), 'Freed: 12 items.', 'pedaço variável que também é frase do app')
  assert.equal(t('Algo novo · 3 GB'), null, 'sem nada conhecido: fica como está')
  assert.equal(t('UEFI · sem Secure Boot'), 'UEFI · no Secure Boot', 'item "· x" também vale sem o separador')
  assert.equal(t('a pasta do jogo itens'), null, 'pedaço em português sem tradução não vira mistura ("{0} itens")')
  assert.equal(t('Pode apagar; a pasta do jogo itens'), null, 'lista "a; b" com parte sem tradução: não traduz pela metade')
  assert.equal(t('3,2 GB'), null, 'números/tamanhos não passam pelo tradutor')
  assert.equal(t('C:\\Users\\x'), null)
  assert.equal(norm('  Pode \n  apagar '), 'Pode apagar')

  const source = (JSON.parse(readFileSync('src/renderer/src/i18n/source.json', 'utf8')) as { text: string }[]).map((e) => e.text)
  const tokens = (s: string): string => (s.match(/\{\d+\}/g) ?? []).sort().join(',')
  for (const lang of ['en', 'es', 'zh-CN']) {
    const cat = JSON.parse(readFileSync(`src/renderer/src/i18n/locales/${lang}.json`, 'utf8')) as Record<string, string>
    const keys = Object.keys(cat)
    for (const k of keys) assert.equal(tokens(cat[k]), tokens(k), `${lang}: marcadores diferentes em "${k}"`)
    const tr = createTranslator(cat)
    // Lista de dicas montada pelo Painel ("a; b"): as duas partes traduzidas, sem mistura.
    const tips = tr('o disco C: está 89% cheio; a unidade E: é HDD (lenta para jogos)')
    assert.ok(tips && !/unidade|cheio|é HDD/.test(tips), `${lang}: lista de dicas meio traduzida: ${tips}`)
    const covered = source.filter((s) => (/\{\d+\}/.test(s) ? keys.includes(s) : tr(s) !== null || cat[s] === s)).length
    console.log(`${lang}: ${keys.length} traduções · cobertura ${Math.round((100 * covered) / source.length)}% de ${source.length} textos`)
  }
  console.log('tradutor e catálogos: OK')
}
