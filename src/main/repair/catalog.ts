// Catálogo das correções (metadados mostrados na interface). A execução fica em fixes.ts.
import type { RepairFix } from '@shared/types/repair'

type FixMeta = Omit<RepairFix, 'id'>

const F: Record<string, FixMeta> = {
  // ---------------- Arquivos do Windows
  'sfc-scannow': {
    label: 'Reparar arquivos do Windows (SFC)',
    description: 'Roda "sfc /scannow": confere todos os arquivos protegidos do Windows e troca os corrompidos por cópias boas. Não mexe nos seus arquivos.',
    requiresAdmin: true,
    longRunning: true,
    duration: '10 a 30 minutos',
    reversible: false,
    risk: 'low',
    confirmText: 'Vai rodar "sfc /scannow" como administrador (10 a 30 minutos). Pode usar o PC enquanto isso, mas não desligue. Se algo for reparado, reinicie no final.'
  },
  'dism-restorehealth-sfc': {
    label: 'Reparar a imagem do Windows (DISM + SFC)',
    description: 'Roda "DISM /RestoreHealth" (baixa do Windows Update os componentes danificados) e, em seguida, "sfc /scannow". É o reparo mais completo do sistema sem reinstalar.',
    requiresAdmin: true,
    longRunning: true,
    duration: '20 a 60 minutos',
    reversible: false,
    risk: 'low',
    confirmText: 'Vai rodar DISM /RestoreHealth e depois SFC como administrador (20 a 60 minutos, precisa de internet). Não desligue o PC até terminar.'
  },
  // ---------------- Disco
  'disk-spotfix': {
    label: 'Corrigir erros do sistema de arquivos (sem reiniciar)',
    description: 'Roda "Repair-Volume -SpotFix" nas unidades escolhidas: corrige na hora os erros já registrados pelo Windows. Em alguns casos o Windows pede um reinício para terminar.',
    requiresAdmin: true,
    longRunning: true,
    duration: '1 a 5 minutos por unidade',
    reversible: false,
    risk: 'low',
    perItem: true,
    confirmText: 'Vai corrigir os erros do sistema de arquivos nas unidades selecionadas. Feche programas e jogos que estejam usando essas unidades.'
  },
  'chkdsk-on-boot': {
    label: 'Verificar e corrigir o disco (chkdsk)',
    description: 'Unidade do Windows (C:): marca para o "chkdsk /f" rodar na próxima inicialização (o Windows não deixa verificar com ele em uso). Outras unidades: roda a verificação completa offline agora (a unidade fica indisponível por alguns minutos).',
    requiresAdmin: true,
    requiresRestart: true,
    longRunning: true,
    duration: 'minutos a horas (depende do tamanho)',
    reversible: false,
    risk: 'medium',
    perItem: true,
    confirmText: 'O chkdsk vai verificar e corrigir o sistema de arquivos. Na unidade C: ele roda ao reiniciar (não desligue o PC durante a verificação). Nas outras, feche tudo o que usa a unidade antes. Tenha backup do que é importante.'
  },
  'open-backup-settings': {
    label: 'Abrir as opções de backup do Windows',
    description: 'Abre as Configurações de backup para você copiar seus arquivos importantes enquanto o disco ainda funciona.',
    requiresAdmin: false,
    reversible: false,
    risk: 'low',
    opensOnly: true,
    confirmText: 'Abrir as configurações de backup do Windows.'
  },
  'open-storage-settings': {
    label: 'Abrir o Armazenamento do Windows',
    description: 'Abre Configurações > Armazenamento. Para liberar espaço com segurança, use também a página Limpeza do app.',
    requiresAdmin: false,
    reversible: false,
    risk: 'low',
    opensOnly: true,
    confirmText: 'Abrir as configurações de armazenamento.'
  },
  // ---------------- Windows Update
  'wu-reset': {
    label: 'Reparar o Windows Update',
    description: 'Para os serviços do Windows Update (wuauserv, BITS, Criptografia, Windows Installer), RENOMEIA as pastas de cache SoftwareDistribution e catroot2 para ".old-<data>" (nada é apagado) e religa os serviços. O Windows recria o cache do zero; a próxima busca de atualizações demora um pouco mais.',
    requiresAdmin: true,
    requiresRestart: false,
    reversible: false,
    risk: 'low',
    duration: '1 a 3 minutos',
    confirmText: 'Vai parar o Windows Update, renomear as pastas de cache (SoftwareDistribution e catroot2 viram ".old-<data>"; nada é apagado) e religar os serviços. Depois, abra o Windows Update e clique em "Verificar atualizações". As pastas antigas podem ser apagadas depois pela Limpeza.'
  },
  'wu-enable-services': {
    label: 'Religar os serviços do Windows Update',
    description: 'Volta os serviços essenciais do Windows Update que estão DESATIVADOS para o modo padrão do Windows. Dá para desfazer pelo Histórico.',
    requiresAdmin: true,
    reversible: true,
    risk: 'low',
    perItem: true,
    confirmText: 'Os serviços selecionados voltam ao tipo de inicialização padrão do Windows. Dá para desfazer pelo Histórico.'
  },
  'open-windows-update': {
    label: 'Abrir o Windows Update',
    description: 'Abre Configurações > Windows Update.',
    requiresAdmin: false,
    reversible: false,
    risk: 'low',
    opensOnly: true,
    confirmText: 'Abrir o Windows Update.'
  },
  // ---------------- Entradas quebradas
  'remove-broken-startup': {
    label: 'Remover entradas de inicialização quebradas',
    description: 'Apaga do registro só os valores de inicialização (Run/RunOnce) que apontam para arquivos que não existem mais. Antes, exporta um backup .reg e guarda o valor para o Desfazer.',
    requiresAdmin: false,
    reversible: true,
    risk: 'low',
    perItem: true,
    confirmText: 'As entradas selecionadas serão removidas do registro (com backup .reg). O programa delas já não existe, então nada deixa de abrir. Dá para desfazer pelo Histórico.'
  },
  'trash-broken-shortcuts': {
    label: 'Mover atalhos quebrados para a Lixeira',
    description: 'Atalhos que apontam para programas/arquivos que não existem mais vão para a Lixeira. Uma cópia fica no backup do app para o Desfazer.',
    requiresAdmin: false,
    reversible: true,
    risk: 'low',
    perItem: true,
    confirmText: 'Os atalhos selecionados vão para a Lixeira (com cópia de backup). Dá para desfazer pelo Histórico.'
  },
  'disable-broken-tasks': {
    label: 'Desativar tarefas agendadas quebradas',
    description: 'DESATIVA (não apaga) as tarefas agendadas cujo programa não existe mais: elas param de falhar em segundo plano. Dá para reativar pelo Desfazer.',
    requiresAdmin: false,
    reversible: true,
    risk: 'low',
    perItem: true,
    confirmText: 'As tarefas selecionadas serão desativadas (não apagadas). Algumas podem pedir permissão de administrador. Dá para desfazer pelo Histórico.'
  },
  'disable-broken-services': {
    label: 'Desativar serviços quebrados',
    description: 'Muda para "Desativado" os serviços de outros fabricantes que iniciam com o Windows mas cujo programa não existe mais (o Windows tenta abri-los a cada inicialização e registra erro). Dá para desfazer.',
    requiresAdmin: true,
    reversible: true,
    risk: 'low',
    perItem: true,
    confirmText: 'Os serviços selecionados passam para "Desativado" (o programa deles já não existe). Precisa de administrador. Dá para desfazer pelo Histórico.'
  },
  'remove-broken-app-paths': {
    label: 'Remover registros de programas que não existem',
    description: 'Remove as chaves "App Paths" de programas desinstalados (usadas pelo Executar/Win+R). Backup .reg e Desfazer.',
    requiresAdmin: false,
    reversible: true,
    risk: 'low',
    perItem: true,
    confirmText: 'As chaves selecionadas serão removidas (com backup .reg). Dá para desfazer pelo Histórico.'
  },
  'remove-broken-fonts': {
    label: 'Remover fontes registradas sem arquivo',
    description: 'Remove do registro as fontes cujo arquivo não existe mais (só organiza; não acelera o PC). Backup e Desfazer.',
    requiresAdmin: false,
    reversible: true,
    risk: 'low',
    perItem: true,
    confirmText: 'Os registros de fonte selecionados serão removidos (com backup). Dá para desfazer pelo Histórico.'
  },
  'open-default-apps': {
    label: 'Abrir "Aplicativos padrão"',
    description: 'Abre Configurações > Aplicativos padrão para escolher de novo qual programa abre esses arquivos.',
    requiresAdmin: false,
    reversible: false,
    risk: 'low',
    opensOnly: true,
    confirmText: 'Abrir os aplicativos padrão.'
  },
  // ---------------- Explorer
  'block-shell-extensions': {
    label: 'Bloquear extensões quebradas do Explorer',
    description: 'Coloca as extensões quebradas na lista de bloqueio oficial do Windows (Shell Extensions\\Blocked): o Explorer para de tentar carregá-las. Nada é apagado; dá para desfazer.',
    requiresAdmin: true,
    reversible: true,
    risk: 'low',
    perItem: true,
    confirmText: 'As extensões selecionadas serão bloqueadas (o Explorer deixa de carregá-las). Precisa de administrador. Reinicie o Explorer ou o PC para ver o efeito. Dá para desfazer pelo Histórico.'
  },
  // ---------------- Travamentos
  'open-reliability-monitor': {
    label: 'Abrir o Monitor de Confiabilidade',
    description: 'Mostra, dia a dia, cada falha do Windows e dos programas, com detalhes técnicos.',
    requiresAdmin: false,
    reversible: false,
    risk: 'low',
    opensOnly: true,
    confirmText: 'Abrir o Monitor de Confiabilidade.'
  },
  'open-memory-diagnostic': {
    label: 'Abrir o Diagnóstico de Memória do Windows',
    description: 'Abre a ferramenta oficial que testa a memória RAM ao reiniciar (você escolhe quando reiniciar). Pede permissão de administrador.',
    requiresAdmin: false,
    reversible: false,
    risk: 'low',
    opensOnly: true,
    confirmText: 'Abrir o Diagnóstico de Memória do Windows (ele mesmo pergunta quando reiniciar).'
  },
  // ---------------- Rede
  'flush-dns': {
    label: 'Limpar o cache de DNS',
    description: 'Apaga a memória de endereços de sites (é refeita sozinha). Resolve sites que não abrem ou abrem o endereço antigo.',
    requiresAdmin: false,
    reversible: false,
    risk: 'low',
    confirmText: 'O cache de DNS será limpo (é refeito automaticamente).'
  },
  'reset-network': {
    label: 'Redefinir a rede (Winsock e TCP/IP)',
    description: 'Roda "netsh winsock reset" e "netsh int ip reset": volta a pilha de rede do Windows ao padrão (remove provedores de rede de terceiros quebrados). Precisa reiniciar.',
    requiresAdmin: true,
    requiresRestart: true,
    reversible: false,
    risk: 'medium',
    confirmText: 'A rede do Windows volta ao padrão. Se você configurou IP fixo ou DNS manual, terá de configurar de novo; VPNs e alguns antivírus podem precisar ser reinstalados. Reinicie o PC depois.'
  },
  'disable-proxy': {
    label: 'Desligar o proxy',
    description: 'Desliga o proxy configurado para o seu usuário (o valor antigo fica guardado para o Desfazer).',
    requiresAdmin: false,
    reversible: true,
    risk: 'low',
    confirmText: 'O proxy do seu usuário será desligado (navegadores passam a conectar direto). Se você usa esse proxy de propósito (empresa, VPN), não continue. Dá para desfazer pelo Histórico.'
  },
  'comment-hosts-lines': {
    label: 'Desativar linhas do arquivo hosts',
    description: 'Coloca "#" na frente das linhas escolhidas do arquivo hosts (elas deixam de valer). Uma cópia do arquivo original fica no backup para o Desfazer.',
    requiresAdmin: true,
    reversible: true,
    risk: 'low',
    perItem: true,
    confirmText: 'As linhas selecionadas do arquivo hosts serão desativadas (comentadas com #), com backup do arquivo original. Precisa de administrador. Dá para desfazer pelo Histórico.'
  },
  // ---------------- Segurança
  'defender-update-signatures': {
    label: 'Atualizar as definições do antivírus',
    description: 'Baixa as definições mais recentes do Microsoft Defender.',
    requiresAdmin: false,
    longRunning: true,
    duration: '1 a 3 minutos',
    reversible: false,
    risk: 'low',
    confirmText: 'O Microsoft Defender vai baixar as definições mais recentes (precisa de internet).'
  },
  'defender-quick-scan': {
    label: 'Fazer uma verificação rápida de vírus',
    description: 'Roda a verificação rápida do Microsoft Defender (memória, inicialização e pastas mais visadas).',
    requiresAdmin: false,
    longRunning: true,
    duration: '5 a 15 minutos',
    reversible: false,
    risk: 'low',
    confirmText: 'O Microsoft Defender vai fazer uma verificação rápida (5 a 15 minutos). Se encontrar algo, ele mesmo avisa e trata.'
  },
  'open-windows-security': {
    label: 'Abrir a Segurança do Windows',
    description: 'Abre a tela de proteção contra vírus e ameaças.',
    requiresAdmin: false,
    reversible: false,
    risk: 'low',
    opensOnly: true,
    confirmText: 'Abrir a Segurança do Windows.'
  },
  // ---------------- Relógio
  'time-resync': {
    label: 'Acertar o relógio agora',
    description: 'Liga o serviço de Horário do Windows (se estiver desativado, volta ao padrão "Manual") e sincroniza com o servidor de hora da Microsoft.',
    requiresAdmin: true,
    reversible: false,
    risk: 'low',
    confirmText: 'O relógio será sincronizado com time.windows.com. Precisa de administrador.'
  },
  // ---------------- Aparência
  'rebuild-icon-cache': {
    label: 'Reconstruir o cache de ícones e miniaturas',
    description: 'Fecha o Explorer, apaga os arquivos de cache de ícones/miniaturas (iconcache/thumbcache) e abre o Explorer de novo. O Windows recria tudo. Resolve ícones em branco, errados ou miniaturas antigas.',
    requiresAdmin: false,
    reversible: false,
    risk: 'low',
    confirmText: 'A barra de tarefas e as janelas de pastas vão SUMIR por alguns segundos (a tela pisca) e voltar sozinhas. Salve o que estiver fazendo. As miniaturas são recriadas aos poucos.'
  },
  wsreset: {
    label: 'Redefinir o cache da Microsoft Store',
    description: 'Roda "wsreset": limpa o cache da Microsoft Store sem apagar apps nem a conta. Resolve downloads travados e a Store que não abre.',
    requiresAdmin: false,
    reversible: false,
    risk: 'low',
    confirmText: 'Vai rodar "wsreset": uma janela preta aparece por alguns segundos e a Microsoft Store abre sozinha no final.'
  }
}

export function fixMeta(id: string, overrides: Partial<FixMeta> = {}): RepairFix {
  const m = F[id]
  if (!m) throw new Error(`Correção desconhecida: ${id}`)
  return { id, ...m, ...overrides }
}

export function hasFix(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(F, id)
}

export const FIX_IDS = Object.keys(F)
