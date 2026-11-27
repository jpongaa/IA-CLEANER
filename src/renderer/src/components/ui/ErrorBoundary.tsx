// Isola erros de renderização: uma tela que quebra (dado inesperado de outro PC, por exemplo) mostra um aviso
// com "Recarregar esta tela" em vez de derrubar o app inteiro (menu lateral incluído).
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from './primitives'

export interface ErrorBoundaryProps {
  children: ReactNode
  /** Nome da tela (aparece na mensagem). */
  label?: string
}

interface State {
  error: Error | null
  /** Muda a cada "Recarregar" para remontar a tela do zero. */
  attempt: number
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[tela] erro de renderização:', error, info.componentStack)
  }

  private reload = (): void => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))
  }

  render(): ReactNode {
    const { error, attempt } = this.state
    if (!error) return <Fragment key={attempt}>{this.props.children}</Fragment>
    return (
      <div role="alert" className="mx-auto mt-10 max-w-xl rounded-xl border border-danger/40 bg-danger/10 p-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-text">
              {this.props.label ? `A tela "${this.props.label}" teve um erro inesperado` : 'Esta tela teve um erro inesperado'}
            </h2>
            <p className="mt-1 text-[13px] text-muted">
              O resto do app continua funcionando: use o menu ao lado ou tente recarregar só esta tela. Nada foi alterado no seu PC.
            </p>
            <p className="selectable mt-3 rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-[12px] break-words text-muted">
              {error.message || String(error)}
            </p>
            <Button className="mt-4" variant="secondary" icon={RefreshCw} onClick={this.reload}>
              Recarregar esta tela
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
