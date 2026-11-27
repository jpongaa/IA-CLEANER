// Fábrica de achados e ações (textos PT-BR simples e honestos).
import type { Finding, FindingAction, FindingKind } from '@shared/types/discover'
import { formatBytes, formatDate, formatRelative } from '@shared/format'
import { pkey } from './fsx'

export const CONFIRM_WORD = 'REMOVER'

export function findingId(kind: FindingKind, p: string): string {
  return `${kind}:${pkey(p)}`
}

export const act = {
  recycle(what: string): FindingAction {
    return {
      kind: 'recycle',
      label: 'Mover para a Lixeira',
      confirmText: `Mover para a Lixeira: ${what}. Se mudar de ideia, dá para restaurar pela Lixeira do Windows.`
    }
  },
  deleteLeftovers(what: string, admin: boolean): FindingAction {
    return {
      kind: 'deleteLeftovers',
      label: 'Apagar sobras',
      requiresAdmin: admin,
      confirmText:
        `Mover para a Lixeira a pasta ${what}. Antes de mover, o app confere de novo que nenhum programa instalado, serviço, tarefa ou programa aberto usa esta pasta.` +
        (admin ? ' O Windows vai pedir permissão de administrador.' : '')
    }
  },
  runUninstaller(name: string, target: string | undefined, admin: boolean): FindingAction {
    return {
      kind: 'runUninstaller',
      label: 'Abrir o desinstalador',
      requiresAdmin: admin,
      target,
      confirmText: `Abrir o desinstalador oficial de "${name}". A desinstalação acontece na janela dele: siga as instruções por lá.`
    }
  },
  forceRemove(name: string, folder: string, admin: boolean, extra: string[] = []): FindingAction {
    return {
      kind: 'forceRemove',
      label: 'Remover à força',
      requiresAdmin: admin,
      dangerous: true,
      confirmWord: CONFIRM_WORD,
      confirmText:
        `Remover "${name}" sem desinstalador: ${extra.length ? extra.join('; ') + '; ' : ''}mover a pasta "${folder}" para a Lixeira` +
        ' e apagar a entrada da lista de programas do Windows (com backup). Use só se o desinstalador não existe ou não funciona.' +
        (admin ? ' O Windows vai pedir permissão de administrador.' : '')
    }
  },
  removeBrokenEntry(name: string, admin: boolean): FindingAction {
    return {
      kind: 'removeBrokenEntry',
      label: 'Tirar da lista de programas',
      requiresAdmin: admin,
      confirmText:
        `Apagar só a entrada "${name}" da lista de programas do Windows (o desinstalador dela não existe mais). Um backup (.reg) é salvo e dá para desfazer pelo Histórico.` +
        (admin ? ' O Windows vai pedir permissão de administrador.' : '')
    }
  },
  disableStartup(n: number): FindingAction {
    return {
      kind: 'disableStartup',
      label: 'Tirar da inicialização',
      confirmText: `Desativar ${n === 1 ? 'o item' : `os ${n} itens`} de inicialização deste programa (como no Gerenciador de Tarefas). Nada é apagado e dá para reativar depois.`
    }
  },
  openFolder(): FindingAction {
    return { kind: 'openFolder', label: 'Abrir pasta' }
  },
  openSettings(uri: string, label: string): FindingAction {
    return { kind: 'openSettings', label, target: uri }
  },
  openLauncher(name: string): FindingAction {
    return { kind: 'openLauncher', label: `Abrir ${name}` }
  },
  learnMore(url: string): FindingAction {
    return { kind: 'learnMore', label: 'Saiba mais', target: url }
  }
}

export function sizeText(bytes: number, approximate?: boolean): string {
  return `${approximate ? 'pelo menos ' : ''}${formatBytes(bytes)}`
}

export function whenText(ms: number | undefined): string {
  if (!ms) return 'data desconhecida'
  return `${formatDate(ms)} (${formatRelative(ms)})`
}

export function base(kind: FindingKind, id: string, fields: Omit<Finding, 'id' | 'kind'>): Finding {
  return { id, kind, ...fields }
}

/** Nome "bonito" de pasta de jogo/repack: tira tags como [FitGirl Repack], (v1.2.3), -CODEX. */
export function cleanTitle(name: string): string {
  let s = name
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ')
  s = s.replace(/[-_. ](fitgirl|dodi|elamigos|codex|skidrow|empress|tenoke|rune|flt|plaza|gog|repack|portable|multi\d*)\b.*$/i, ' ')
  s = s.replace(/\bv?\d+(\.\d+){1,}[a-z]?\b/gi, ' ')
  s = s.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()
  return s || name
}
