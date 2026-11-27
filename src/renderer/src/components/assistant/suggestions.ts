// Perguntas prontas do Assistente IA (PT-BR). A página usa ASSISTANT_SUGGESTIONS; o painel lateral usa
// HEALTH_SUGGESTIONS (erros reais e o que o "Otimizar tudo" mudou) e FORGOTTEN_SUGGESTIONS (o que ficou para trás:
// sobras de desinstalações, instaladores e jogos esquecidos).
import { Archive, Bug, Gamepad2, Gauge, HardDrive, MemoryStick, PackageX, PowerOff, ScanSearch, Sparkles, Turtle, Wand2, type LucideIcon } from 'lucide-react'

export interface AssistantSuggestion {
  icon: LucideIcon
  text: string
}

/** Perguntas sobre erros reais do Windows (Reparar Erros) e sobre o que o app já mudou (Histórico + medições). */
export const HEALTH_SUGGESTIONS: readonly AssistantSuggestion[] = [
  { icon: PowerOff, text: 'Por que meu PC desliga sozinho?' },
  { icon: Wand2, text: 'O que o Otimizar tudo mudou?' },
  { icon: Bug, text: 'Algum programa está travando?' }
]

/** Perguntas sobre o que ficou esquecido no PC (Busca Profunda + desinstalações recentes). */
export const FORGOTTEN_SUGGESTIONS: readonly AssistantSuggestion[] = [
  { icon: PackageX, text: 'O que sobrou de programas que desinstalei?' },
  { icon: ScanSearch, text: 'Tenho instaladores ou jogos esquecidos?' },
  { icon: Archive, text: 'Quais zips eu já extraí e posso apagar?' }
]

/** Lista completa (as 3 primeiras aparecem também como atalhos depois da 1ª pergunta). */
export const ASSISTANT_SUGGESTIONS: readonly AssistantSuggestion[] = [
  { icon: Turtle, text: 'Por que meu PC está lento?' },
  HEALTH_SUGGESTIONS[0],
  HEALTH_SUGGESTIONS[1],
  { icon: Gamepad2, text: 'Quais jogos posso desinstalar?' },
  FORGOTTEN_SUGGESTIONS[0],
  FORGOTTEN_SUGGESTIONS[1],
  { icon: MemoryStick, text: 'Vale a pena colocar mais RAM?' },
  { icon: HardDrive, text: 'Meu SSD está saudável?' },
  { icon: Gauge, text: 'O que mais está ocupando espaço no meu C:?' },
  { icon: Sparkles, text: 'O que posso apagar com segurança?' }
]
