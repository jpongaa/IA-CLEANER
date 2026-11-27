<div align="center">

🇺🇸 [English](README.md) · 🇧🇷 **Português**


<img src="build/icon.png" width="96" alt="IA Cleaner" />

# IA Cleaner

**Limpeza, diagnóstico e otimização do PC com Inteligência Artificial — com segurança e explicando tudo.**

O app **analisa sozinho** os discos, o lixo, jogos, programas, desempenho, hardware e drivers.
Depois a **IA interpreta**: diz o que pode apagar, o que **não** pode, o que ela não reconhece (e pesquisa na internet),
e o que realmente está deixando o seu PC lento.

![Windows 10/11](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![IA](https://img.shields.io/badge/IA-Claude%20%7C%20ChatGPT%20%7C%20Gemini%20%7C%20Grok%20%7C%20local-D97757)
![Licença MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-green)

</div>

> **A IA só recomenda.** Nada é apagado, desinstalado ou alterado sem você confirmar na tela — e tudo fica no Histórico.

---

## ✨ O que ele faz

| Tela | O que faz |
|---|---|
| **Painel** | Nota de saúde do PC e **Checkup Completo** (só leitura): discos, espaço recuperável e principais problemas. |
| **Análise de Discos** | Varredura rápida de todos os HDs/SSDs: mapa de pastas, maiores arquivos, arquivos esquecidos, uso por tipo e **duplicados**. Inclui **"Tudo que dá para apagar"**: junta tudo num lugar só e a IA explica item a item — *Pode apagar*, *Melhor não apagar* ou *Não sei o que é* (aí ela pesquisa). |
| **Limpeza Inteligente** | Caches, temporários, dumps, sobras de drivers, Windows Update e uma **busca extrema** (discos virtuais de emuladores, caches gigantes de apps…), separados em *Pode apagar / Revisar / Manter*. |
| **Busca Profunda** | Acha o que ficou perdido: **sobras de programas já desinstalados**, instaladores esquecidos em Downloads, `.zip`/`.rar` já extraídos, programas sem desinstalador e programas indesejados. |
| **Jogos & Programas** | Todos os jogos (Steam, Epic, EA, Ubisoft, Battle.net, GOG, Xbox, Riot…) e programas, com tamanho, **último uso** e tempo jogado. Desinstala pelo desinstalador oficial. |
| **Desempenho** | Mostra **por que o PC está lento** (inicialização, RAM/XMP, disco cheio, processos, energia, antivírus duplicado…) e tem **Otimizar tudo**, com Desfazer e ponto de restauração. |
| **Reparar Erros** | Problemas reais do Windows (atalhos quebrados, entradas órfãs, erros de disco/hardware no log), com correção segura e Desfazer. |
| **Hardware** | Estilo CPU-Z: processador, placa-mãe, memória, vídeo, discos, monitores — com **monitor ao vivo**. |
| **Drivers** | Versões e idade dos drivers, dispositivos com erro e links **só de sites oficiais**. A IA pode pesquisar a versão mais recente. |
| **Assistente IA** | Converse sobre o seu PC: *"vale a pena mais RAM?"*, *"quais jogos posso desinstalar?"*… |
| **Histórico** | Tudo o que o app fez, com espaço liberado e **Desfazer**. |

## 📥 Instalar

1. Baixe a última versão na página **[Releases](../../releases)**:
   - `IA-Cleaner-Setup-x.y.z.exe` — instala e cria atalhos;
   - `IA-Cleaner-Portable-x.y.z.exe` — roda sem instalar.
2. O executável não tem assinatura digital paga, então o Windows pode mostrar *"O Windows protegeu o computador"*.
   Clique em **Mais informações → Executar assim mesmo**.

Prefere compilar você mesmo? Veja [Para desenvolvedores](#-para-desenvolvedores).

## 🔑 Conecte a sua própria IA — qualquer uma das famosas

O IA Cleaner **não vem com chave nenhuma**: cada pessoa conecta **a sua própria IA** e paga só o que usar (ou nada, com IA local).
Sem IA, todo o resto do app funciona normalmente — só as análises com IA ficam desligadas.

| Provedor | Onde pegar a chave |
|---|---|
| **Anthropic — Claude** *(recomendado)* | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| **OpenAI — ChatGPT** | [platform.openai.com](https://platform.openai.com/api-keys) |
| **Google — Gemini** | [aistudio.google.com](https://aistudio.google.com/apikey) |
| **xAI — Grok** | [console.x.ai](https://console.x.ai) |
| **DeepSeek** | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |
| **Mistral** | [console.mistral.ai](https://console.mistral.ai/api-keys) |
| **OpenRouter** (centenas de modelos: Llama, Qwen…) | [openrouter.ai](https://openrouter.ai/keys) |
| **IA local** — Ollama, LM Studio ou qualquer API compatível com OpenAI | não precisa de chave |

1. No app: **Configurações → Sua IA** → escolha o provedor.
2. Cole a chave → **Salvar chave**. Cada provedor guarda a sua própria chave, criptografada.
3. Clique em **Carregar modelos**, escolha um modelo → **Testar conexão** (listar modelos e testar não gastam créditos).

> Com o **Claude**, a IA também **pesquisa na internet** o que não conhece (e as versões de drivers), e o app estima o custo de
> cada análise. Nos outros provedores a análise usa o conhecimento do próprio modelo, e o custo aparece no painel do provedor.

Prefere variável de ambiente? `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`,
`MISTRAL_API_KEY`, `OPENROUTER_API_KEY` ou `OPENAI_COMPAT_API_KEY` (a chave salva nas Configurações tem prioridade).

## 🔒 Privacidade e segurança

- **A chave fica no seu PC**, criptografada pelo Windows (DPAPI), e nunca volta para a tela.
- **Para a IA vão só nomes, tamanhos e especificações** — nunca o conteúdo dos seus arquivos.
  Com *Anonimizar caminhos* ligado, `C:\Users\<seu nome>` vira `%USERPROFILE%`.
- O app fala **só** com a IA que **você** escolheu. Não há servidor próprio, cadastro, telemetria nem atualizador automático.
- **Guard de exclusão:** toda exclusão passa por ele, que bloqueia Windows, Arquivos de Programas, ProgramData, raízes
  de unidades, a estrutura do seu perfil, pastas de jogos/programas instalados, pagefile/hiberfil e junctions/links.
- **Prefetch e cache do Windows Installer nunca são limpos** — apagar esses deixa o PC mais lento ou quebra atualizações.
- **Nada de "otimizadores de RAM", "limpadores de registro" milagrosos ou atualizadores de driver de terceiros.**

## 🤔 Por que apagar arquivos não deixava o PC mais rápido?

Espaço livre não é velocidade: caches existem para **acelerar** e voltam a crescer depois de apagados. Limpar só ajuda
de verdade quando o **disco do Windows está quase cheio** (menos de 10–15% livre). O que normalmente pesa é:
programas abrindo com o Windows, pouca RAM ou RAM abaixo da velocidade, disco do sistema lotado, Windows sem reiniciar
há dias, antivírus duplicado, drivers desatualizados, superaquecimento e jogos instalados em HD mecânico.
A tela **Desempenho** mede tudo isso no seu PC.

---

## 🛠 Para desenvolvedores

**Requisitos:** Windows 10/11, **Node 22+** e **.NET SDK 8** (para o helper de varredura rápida).

```powershell
git clone https://github.com/jpongaa/IA-CLEANER.git
cd IA-CLEANER
npm install
npm run build:scanner    # compila native/scanner -> resources/bin/iacleaner-scanner.exe (opcional: sem ele o app usa um modo mais lento)
npm run dev              # abre o app em modo desenvolvimento
npm run typecheck        # checa os tipos
npm run dist             # gera o instalador e a versão portátil em dist\
```

Testes do backend (somente leitura; os da IA usam um servidor falso local e não gastam créditos):

```powershell
npx tsx --tsconfig tsconfig.node.json scripts/smoke/run.ts cleanup-guard
```

Arquitetura, regras de segurança e convenções: [CONTRIBUTING.md](CONTRIBUTING.md).

**Stack:** Electron 44 · electron-vite · React 19 · TypeScript · Tailwind 4 · recharts · lucide-react · zod ·
SDK oficial da Anthropic + qualquer API compatível com OpenAI · helper em C# (.NET 8) para varrer discos rápido.

## 🤝 Contribuindo

Issues e pull requests são bem-vindos! Antes de mexer em algo que apaga ou altera o PC, leia as regras de segurança em
[CONTRIBUTING.md](CONTRIBUTING.md).

## ⚠️ Aviso

Use por sua conta e risco. O app foi feito para ser conservador, mas nenhum limpador substitui backup:
mantenha cópia do que é importante. Este projeto não é afiliado à Anthropic nem a nenhum fabricante citado.

## 📄 Licença

[MIT](LICENSE)
