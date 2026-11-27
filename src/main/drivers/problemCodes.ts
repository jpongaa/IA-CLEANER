// Códigos de erro do Gerenciador de Dispositivos (CM_PROB_*) em PT-BR, com orientação para leigos.
// Referência: "Device Manager error codes" (Microsoft Learn).

export interface ProblemCodeInfo {
  text: string
  hint: string
  severity: 'error' | 'warning' | 'info'
}

const REINSTALL = 'Abra o Gerenciador de Dispositivos, clique com o botão direito no dispositivo > Desinstalar dispositivo, reinicie o PC e instale o driver pelo site oficial do fabricante.'
const UPDATE = 'Instale o driver mais recente pelo site oficial do fabricante (veja "Onde baixar") ou pelas Atualizações opcionais do Windows Update.'

const CODES: Record<number, ProblemCodeInfo> = {
  1: { text: 'O dispositivo não está configurado corretamente.', hint: UPDATE, severity: 'error' },
  3: {
    text: 'O driver pode estar corrompido ou o sistema está com pouca memória.',
    hint: 'Feche programas e reinicie o PC. Se continuar, reinstale o driver. ' + REINSTALL,
    severity: 'error'
  },
  10: {
    text: 'O dispositivo não pode ser iniciado.',
    hint: 'Atualize o driver pelo site oficial. Se for USB, teste outra porta ou cabo.',
    severity: 'error'
  },
  12: {
    text: 'Não há recursos livres suficientes para o dispositivo (conflito com outro dispositivo).',
    hint: 'Desative dispositivos que você não usa ou atualize o BIOS da placa-mãe.',
    severity: 'error'
  },
  14: { text: 'O dispositivo só vai funcionar depois que o computador for reiniciado.', hint: 'Reinicie o PC.', severity: 'warning' },
  16: { text: 'O Windows não consegue identificar todos os recursos que o dispositivo usa.', hint: UPDATE, severity: 'error' },
  18: { text: 'Os drivers deste dispositivo precisam ser reinstalados.', hint: REINSTALL, severity: 'error' },
  19: {
    text: 'As informações de configuração deste dispositivo no registro estão incompletas ou danificadas.',
    hint: 'Desinstale e reinstale o programa/driver relacionado a este dispositivo. ' + REINSTALL,
    severity: 'error'
  },
  21: { text: 'O Windows está removendo este dispositivo.', hint: 'Aguarde alguns segundos e reinicie o PC.', severity: 'warning' },
  22: {
    text: 'O dispositivo está desativado.',
    hint: 'Se foi você (ou um programa) que desativou, está tudo bem. Para usar, clique com o botão direito no Gerenciador de Dispositivos > Habilitar dispositivo.',
    severity: 'info'
  },
  24: {
    text: 'O dispositivo não está presente, não está funcionando direito ou não tem todos os drivers instalados.',
    hint: 'Verifique se está bem conectado. ' + UPDATE,
    severity: 'error'
  },
  28: {
    text: 'Os drivers deste dispositivo não estão instalados.',
    hint: 'Procure em Atualizações opcionais do Windows Update ou no site oficial do fabricante (placa-mãe/notebook).',
    severity: 'error'
  },
  29: {
    text: 'O dispositivo está desativado pelo firmware (BIOS/UEFI).',
    hint: 'Se precisar dele, ative-o nas configurações do BIOS.',
    severity: 'info'
  },
  31: { text: 'O Windows não consegue carregar os drivers necessários para este dispositivo.', hint: REINSTALL, severity: 'error' },
  32: {
    text: 'O serviço do driver deste dispositivo foi desativado.',
    hint: 'Reinstale o driver pelo site oficial; algum programa de "otimização" pode ter desativado o serviço.',
    severity: 'error'
  },
  33: { text: 'O Windows não consegue determinar os recursos de que este dispositivo precisa.', hint: 'Atualize o BIOS e o driver; pode ser defeito de hardware.', severity: 'error' },
  34: { text: 'O Windows não consegue determinar as configurações deste dispositivo.', hint: 'Consulte o manual do dispositivo.', severity: 'error' },
  35: {
    text: 'O firmware (BIOS) do computador não tem informações suficientes para configurar este dispositivo.',
    hint: 'Atualize o BIOS pelo site do fabricante da placa-mãe/notebook.',
    severity: 'error'
  },
  36: { text: 'Conflito de interrupção (IRQ) com outro dispositivo.', hint: 'Atualize o BIOS ou revise as configurações de IRQ no BIOS.', severity: 'error' },
  37: { text: 'O Windows não consegue inicializar o driver deste dispositivo.', hint: REINSTALL, severity: 'error' },
  38: { text: 'O Windows não pode carregar o driver porque uma versão anterior ainda está na memória.', hint: 'Reinicie o PC.', severity: 'warning' },
  39: { text: 'O driver deste dispositivo está corrompido ou ausente.', hint: REINSTALL, severity: 'error' },
  40: { text: 'As informações do serviço do driver no registro estão ausentes ou incorretas.', hint: REINSTALL, severity: 'error' },
  41: {
    text: 'O driver foi carregado, mas o dispositivo não foi encontrado.',
    hint: 'Verifique a conexão do dispositivo. Se ele não existe mais, pode desinstalá-lo no Gerenciador de Dispositivos.',
    severity: 'error'
  },
  42: { text: 'Existe um dispositivo duplicado no sistema.', hint: 'Reinicie o PC. Se continuar, reinstale o driver.', severity: 'error' },
  43: {
    text: 'O Windows parou este dispositivo porque ele relatou problemas.',
    hint: 'Comum em placa de vídeo e USB: atualize o driver pelo site oficial, teste outra porta/cabo. Se persistir, pode ser defeito de hardware.',
    severity: 'error'
  },
  44: { text: 'Um programa ou serviço desligou este dispositivo.', hint: 'Reinicie o PC.', severity: 'warning' },
  46: { text: 'O dispositivo não está disponível porque o Windows está sendo desligado.', hint: 'Reinicie o PC.', severity: 'warning' },
  47: { text: 'O dispositivo foi preparado para "remoção segura".', hint: 'Desconecte e conecte o dispositivo de novo.', severity: 'warning' },
  48: {
    text: 'O driver foi bloqueado porque tem problemas conhecidos com o Windows.',
    hint: 'Procure uma versão mais nova e compatível no site oficial do fabricante.',
    severity: 'error'
  },
  49: { text: 'O registro do sistema está grande demais (limite excedido).', hint: 'Desinstale dispositivos antigos que não usa mais e reinicie.', severity: 'error' },
  50: { text: 'O Windows não consegue aplicar todas as propriedades deste dispositivo.', hint: UPDATE, severity: 'error' },
  51: { text: 'O dispositivo está aguardando outro dispositivo iniciar.', hint: 'Resolva primeiro os outros dispositivos com problema e reinicie.', severity: 'warning' },
  52: {
    text: 'O Windows não consegue verificar a assinatura digital do driver.',
    hint: 'Instale o driver oficial (assinado) do site do fabricante. Evite drivers de origem desconhecida.',
    severity: 'error'
  },
  53: { text: 'O dispositivo foi reservado para uso do depurador do kernel do Windows.', hint: 'Normal em PCs de desenvolvimento; ignore se não usa depuração.', severity: 'info' },
  54: { text: 'O dispositivo falhou e está sendo reiniciado.', hint: 'Aguarde; se repetir, atualize o driver.', severity: 'warning' },
  56: { text: 'O Windows ainda está configurando este tipo de dispositivo.', hint: 'Aguarde alguns minutos e reinicie.', severity: 'warning' }
}

/** Códigos que não indicam problema real (45 = dispositivo desconectado no momento). */
export const IGNORED_PROBLEM_CODES = new Set([0, 45])

export function describeProblemCode(code: number): ProblemCodeInfo {
  return (
    CODES[code] ?? {
      text: `O dispositivo está com um erro (código ${code}).`,
      hint: 'Veja os detalhes no Gerenciador de Dispositivos e atualize o driver pelo site oficial do fabricante.',
      severity: 'error'
    }
  )
}
