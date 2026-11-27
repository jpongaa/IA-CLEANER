/** Usado só nos esqueletos dos domínios antes da implementação. */
export function notImplemented(name: string): () => Promise<never> {
  return async () => {
    throw new Error(`${name}: ainda não implementado`)
  }
}
