// Adaptador do `net.fetch` do Electron para o formato `fetch` que o SDK da Anthropic usa.
// O net.fetch passa pela pilha de rede do Chromium: usa o proxy do Windows (inclusive PAC/WPAD) e os certificados
// da loja do Windows (proxies corporativos/antivírus com inspeção HTTPS), o que o fetch do Node não faz.
// Este módulo NÃO importa 'electron' (o main injeta o net.fetch; os testes podem injetar outro).

/** Assinatura do fetch que o SDK chama (url como string ou URL). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Assinatura mínima do net.fetch (aceita string ou Request; não aceita URL). */
export type NetFetchLike = (input: string | Request, init?: RequestInit) => Promise<Response>

export function viaNetFetch(netFetch: NetFetchLike): FetchLike {
  return (input, init) => netFetch(input instanceof URL ? input.href : input, init)
}
