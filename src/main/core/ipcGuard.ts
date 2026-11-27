// Quem pode navegar a janela e chamar o IPC: só a página do próprio app, no frame principal.
// Funções puras (sem 'electron') para poderem ser testadas com tsx.

/**
 * Documento de uma URL file:, para comparação: sem #hash/?query, caminho decodificado (%20 = espaço),
 * barras normalizadas e sem diferença de maiúsculas (caminhos do Windows). Outras URLs: null.
 */
function docOf(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.protocol !== 'file:') return null
    return 'file://' + u.host.toLowerCase() + decodeURIComponent(u.pathname).replace(/\\/g, '/').toLowerCase()
  } catch {
    return null
  }
}

/**
 * Cria o verificador de URL confiável: o index.html do app (file://, comparação exata do documento) e, só em
 * desenvolvimento, a origem do servidor do Vite.
 */
export function makeAppUrlMatcher(appUrl: string, devUrl?: string): (url: string) => boolean {
  const app = docOf(appUrl)
  let devOrigin: string | null = null
  if (devUrl) {
    try {
      devOrigin = new URL(devUrl).origin
    } catch {
      devOrigin = null
    }
  }
  return (url: string): boolean => {
    if (typeof url !== 'string' || !url) return false
    if (app && docOf(url) === app) return true
    if (devOrigin) {
      try {
        return new URL(url).origin === devOrigin
      } catch {
        return false
      }
    }
    return false
  }
}

/** O mínimo de um WebFrameMain que importa aqui. */
export interface FrameLike {
  url: string
  parent: unknown
}

/** O remetente do IPC é o frame principal (sem pai) carregando a página do app? */
export function isTrustedFrame(frame: FrameLike | null | undefined, isAppUrl: (url: string) => boolean): boolean {
  if (!frame) return false
  if (frame.parent) return false
  return isAppUrl(frame.url)
}
