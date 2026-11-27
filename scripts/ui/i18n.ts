// Idiomas na interface REAL, com a janela ESCONDIDA (IACLEANER_HIDDEN=1: nada aparece na tela) e dados de teste
// próprios. Troca o idioma pelo seletor do topo, passa por todas as páginas e lista o que ficou em português.
// Pré-requisito: npx electron-vite build
// Uso: npx tsx --tsconfig tsconfig.node.json scripts/ui/i18n.ts [en|es|zh-CN ...]
import os from 'node:os'
import path from 'node:path'
import { rmSync } from 'node:fs'
import { launchApp } from './harness'

/** Linha com cara de português (acentos/palavras típicas) que deveria ter sido traduzida. */
const PT = /[ãõçÃÕÇ]|(^|[\s(])(não|você|são|também|arquivos?|pasta|apagar|limpeza|configurações|desinstalar|jogos?|unidade|nenhum|agora)([\s.,:;)]|$)/i

async function main(): Promise<void> {
  const langs = process.argv.slice(2).filter((a) => /^(en|es|zh-CN|pt-BR)$/.test(a))
  if (!langs.length) langs.push('en', 'es', 'zh-CN')
  process.env.IACLEANER_HIDDEN = '1'
  const userDataDir = path.join(os.tmpdir(), `iacleaner-ui-i18n-${process.pid}`)
  const h = await launchApp({ userDataDir })
  let worst = 0
  try {
    for (const lang of langs) {
      await h.page.selectOption('select[aria-label="Language / Idioma"]', lang)
      await h.page.waitForTimeout(600)
      const navCount = await h.page.locator('aside nav button').count()
      let lines = 0
      const left = new Map<string, number>()
      for (let i = 0; i < navCount; i++) {
        await h.page.locator('aside nav button').nth(i).click()
        await h.page.waitForTimeout(1500)
        const text = await h.page.evaluate<string>('document.body.innerText')
        for (const raw of text.split('\n')) {
          const l = raw.trim()
          if (!l) continue
          lines++
          if (lang !== 'pt-BR' && PT.test(l)) left.set(l, (left.get(l) ?? 0) + 1)
        }
      }
      const pct = lines ? Math.round((100 * left.size) / lines) : 0
      worst = Math.max(worst, pct)
      console.log(`\n=== ${lang}: ${navCount} páginas · ${lines} linhas visíveis · ${left.size} ainda em português (${pct}%)`)
      for (const l of [...left.keys()].slice(0, 25)) console.log(`  · ${l.slice(0, 140)}`)
    }
    // Voltar para o português devolve os textos originais.
    await h.page.selectOption('select[aria-label="Language / Idioma"]', 'pt-BR')
    await h.page.locator('aside nav button').last().click()
    await h.page.waitForTimeout(1200)
    const back = await h.page.evaluate<string>('document.body.innerText')
    const ptOk = /Configurações/.test(back) && !/\bSettings\b/.test(back)
    console.log(`\nvolta para o português: ${ptOk ? 'OK' : 'FALHOU'}`)
    if (!ptOk) process.exitCode = 1
    console.log(`erros no console: ${h.consoleErrors.length}`)
    for (const e of h.consoleErrors.slice(0, 5)) console.log(`  ! ${e.slice(0, 200)}`)
  } finally {
    await h.close()
    rmSync(userDataDir, { recursive: true, force: true })
  }
  if (h.consoleErrors.some((e) => /Minified React error|Failed to execute|NotFoundError/.test(e))) {
    console.error('FALHOU: o React reclamou do DOM (a tradução não pode criar/remover nós).')
    process.exit(1)
  }
}

void main()
