// Operações de "shell" com implementação injetável: no app usa a API do Electron (setPlatform no main);
// em testes (tsx) usa equivalentes puros do Windows. Domínios usam SEMPRE estas funções.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { runPowerShell, psQuote } from './powershell'

export interface Platform {
  /** Abre URL/URI (https:, steam:, ms-settings:, ...) */
  openExternal(url: string): Promise<void>
  /** Abre o Explorer selecionando o arquivo/pasta */
  showInExplorer(path: string): Promise<void>
  /** Abre um arquivo/pasta com o app padrão */
  openPath(path: string): Promise<void>
  /** Move para a Lixeira (lança erro se falhar) */
  trashItem(path: string): Promise<void>
}

/** Esquemas que o app abre (sites, Configurações do Windows e launchers de jogos). */
export const EXTERNAL_URL_SCHEMES = /^(https?|ms-settings|steam|uplay|com\.epicgames\.launcher|goggalaxy|battlenet|origin2|link2ea|windowsdefender):/i

/**
 * Valida e normaliza uma URL para abrir fora do app. Lança erro se o esquema não for permitido ou se a URL
 * (já normalizada) tiver espaços, aspas duplas ou caracteres de controle, que mudariam a linha de comando.
 */
export function normalizeExternalUrl(url: unknown): string {
  if (typeof url !== 'string') throw new Error('Endereço inválido.')
  let u = url.trim()
  if (!EXTERNAL_URL_SCHEMES.test(u)) throw new Error('Endereço não permitido: ' + u.slice(0, 200))
  if (/^https?:/i.test(u)) {
    try {
      u = new URL(u).href
    } catch {
      throw new Error('Endereço inválido: ' + u.slice(0, 200))
    }
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s"\u0000-\u001f\u007f]/.test(u) || u.length > 2048) throw new Error('Endereço inválido: ' + u.slice(0, 200))
  return u
}

/**
 * Regra para endereços pedidos pela INTERFACE (system.openExternal e links da janela): além da validação de
 * normalizeExternalUrl, só https: e ms-settings:. http: (sem criptografia) e URIs de launchers são recusados;
 * launchers só são abertos pelo main, a partir de dados coletados (ex.: apps/uninstall).
 */
export function normalizeUiExternalUrl(url: unknown): string {
  const u = normalizeExternalUrl(url)
  if (!/^(https:|ms-settings:)/i.test(u)) {
    throw new Error('Endereço não permitido: o app só abre links seguros (https://) e telas das Configurações do Windows.')
  }
  return u
}

/**
 * Comando usado pelo fallback (sem Electron) para abrir uma URL: o manipulador de protocolos do Windows, chamado
 * DIRETAMENTE (sem cmd.exe), com a URL como um único argumento. Exportado para testes.
 */
export function externalOpenCommand(url: string): { file: string; args: string[] } {
  const windir = process.env.SystemRoot ?? 'C:\\Windows'
  return { file: path.join(windir, 'System32', 'rundll32.exe'), args: ['url.dll,FileProtocolHandler', normalizeExternalUrl(url)] }
}

/** Inicia um processo desacoplado; rejeita se ele não puder ser criado. */
function detached(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

const fallback: Platform = {
  async openExternal(url) {
    const { file, args } = externalOpenCommand(url)
    await detached(file, args)
  },
  showInExplorer: (p) => detached('explorer.exe', [`/select,${p}`]),
  openPath: (p) => detached('explorer.exe', [p]),
  /**
   * Lixeira SEM nunca apagar de vez em silêncio (mesmo comportamento do shell.trashItem do Electron): usa o
   * IFileOperation do Windows sem interface e um "observador" que CANCELA a operação se o Windows avisar que o item
   * não iria para a Lixeira (grande demais, unidade sem Lixeira, Lixeira desligada...). Nesse caso nada é apagado e
   * o erro traz o código ETOOBIGFORRECYCLE. (O VisualBasic DeleteDirectory com 'OnlyErrorDialogs' respondia "sim"
   * sozinho à pergunta "apagar permanentemente?".)
   */
  async trashItem(p) {
    // C# 5 (compilador do .NET Framework): IFileOperation + IFileOperationProgressSink. O observador recebe, em
    // PreDeleteItem, a flag TSF_DELETE_RECYCLE_IF_POSSIBLE (0x80): sem ela o Windows apagaria de vez -> E_ABORT.
    // Saída do script: IAC_TRASH_OK | IAC_TRASH_TOO_BIG | IAC_TRASH_ERR:<msg>. Depois de "OK" ainda confere que o
    // item saiu do lugar. (Teste: IACLEANER_TRASH_SIMULATE_NO_RECYCLE=1 finge que o Windows não reciclaria.)
    const TRASH_CS = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IIacShellItem { }

[ComImport, Guid("04b0f1a7-9490-44bc-96e1-4296a31252e2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IIacProgressSink {
  [PreserveSig] int StartOperations();
  [PreserveSig] int FinishOperations(int hrResult);
  [PreserveSig] int PreRenameItem(uint dwFlags, IntPtr psiItem, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
  [PreserveSig] int PostRenameItem(uint dwFlags, IntPtr psiItem, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, int hrRename, IntPtr psiNewlyCreated);
  [PreserveSig] int PreMoveItem(uint dwFlags, IntPtr psiItem, IntPtr psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
  [PreserveSig] int PostMoveItem(uint dwFlags, IntPtr psiItem, IntPtr psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, int hrMove, IntPtr psiNewlyCreated);
  [PreserveSig] int PreCopyItem(uint dwFlags, IntPtr psiItem, IntPtr psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
  [PreserveSig] int PostCopyItem(uint dwFlags, IntPtr psiItem, IntPtr psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, int hrCopy, IntPtr psiNewlyCreated);
  [PreserveSig] int PreDeleteItem(uint dwFlags, IntPtr psiItem);
  [PreserveSig] int PostDeleteItem(uint dwFlags, IntPtr psiItem, int hrDelete, IntPtr psiNewlyCreated);
  [PreserveSig] int PreNewItem(uint dwFlags, IntPtr psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
  [PreserveSig] int PostNewItem(uint dwFlags, IntPtr psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, [MarshalAs(UnmanagedType.LPWStr)] string pszTemplateName, uint dwFileAttributes, int hrNew, IntPtr psiNewItem);
  [PreserveSig] int UpdateProgress(uint iWorkTotal, uint iWorkSoFar);
  [PreserveSig] int ResetTimer();
  [PreserveSig] int PauseTimer();
  [PreserveSig] int ResumeTimer();
}

[ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IIacFileOperation {
  uint Advise(IIacProgressSink pfops);
  void Unadvise(uint dwCookie);
  void SetOperationFlags(uint dwOperationFlags);
  void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string pszMessage);
  void SetProgressDialog([MarshalAs(UnmanagedType.Interface)] object popd);
  void SetProperties([MarshalAs(UnmanagedType.Interface)] object pproparray);
  void SetOwnerWindow(IntPtr hwndOwner);
  void ApplyPropertiesToItem(IIacShellItem psiItem);
  void ApplyPropertiesToItems([MarshalAs(UnmanagedType.Interface)] object punkItems);
  void RenameItem(IIacShellItem psiItem, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, IIacProgressSink pfopsItem);
  void RenameItems([MarshalAs(UnmanagedType.Interface)] object pUnkItems, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName);
  void MoveItem(IIacShellItem psiItem, IIacShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszNewName, IIacProgressSink pfopsItem);
  void MoveItems([MarshalAs(UnmanagedType.Interface)] object punkItems, IIacShellItem psiDestinationFolder);
  void CopyItem(IIacShellItem psiItem, IIacShellItem psiDestinationFolder, [MarshalAs(UnmanagedType.LPWStr)] string pszCopyName, IIacProgressSink pfopsItem);
  void CopyItems([MarshalAs(UnmanagedType.Interface)] object punkItems, IIacShellItem psiDestinationFolder);
  void DeleteItem(IIacShellItem psiItem, IIacProgressSink pfopsItem);
  void DeleteItems([MarshalAs(UnmanagedType.Interface)] object punkItems);
  void NewItem(IIacShellItem psiDestinationFolder, uint dwFileAttributes, [MarshalAs(UnmanagedType.LPWStr)] string pszName, [MarshalAs(UnmanagedType.LPWStr)] string pszTemplateName, IIacProgressSink pfopsItem);
  [PreserveSig] int PerformOperations();
  [return: MarshalAs(UnmanagedType.Bool)] bool GetAnyOperationsAborted();
}

[ComVisible(true)]
public class IacTrashSink : IIacProgressSink {
  public bool WouldNuke;
  public int DeleteResult;
  public int StartOperations() { return 0; }
  public int FinishOperations(int hrResult) { return 0; }
  public int PreRenameItem(uint f, IntPtr a, string b) { return 0; }
  public int PostRenameItem(uint f, IntPtr a, string b, int c, IntPtr d) { return 0; }
  public int PreMoveItem(uint f, IntPtr a, IntPtr b, string c) { return 0; }
  public int PostMoveItem(uint f, IntPtr a, IntPtr b, string c, int d, IntPtr e) { return 0; }
  public int PreCopyItem(uint f, IntPtr a, IntPtr b, string c) { return 0; }
  public int PostCopyItem(uint f, IntPtr a, IntPtr b, string c, int d, IntPtr e) { return 0; }
  public int PreDeleteItem(uint dwFlags, IntPtr psiItem) {
    // TSF_DELETE_RECYCLE_IF_POSSIBLE ausente = o Windows apagaria de vez: cancela (nada é apagado).
    if ((dwFlags & 0x80) == 0 || IacTrash.SimulateNoRecycle) { WouldNuke = true; return unchecked((int)0x80004004); }
    return 0;
  }
  public int PostDeleteItem(uint f, IntPtr a, int hrDelete, IntPtr d) { if (hrDelete < 0) DeleteResult = hrDelete; return 0; }
  public int PreNewItem(uint f, IntPtr a, string b) { return 0; }
  public int PostNewItem(uint f, IntPtr a, string b, string c, uint d, int e, IntPtr g) { return 0; }
  public int UpdateProgress(uint a, uint b) { return 0; }
  public int ResetTimer() { return 0; }
  public int PauseTimer() { return 0; }
  public int ResumeTimer() { return 0; }
}

public static class IacTrash {
  // Testes: finge que o Windows não reciclaria (o item fica onde está).
  public static bool SimulateNoRecycle;

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string pszPath, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IIacShellItem ppv);

  // Devolve "OK", "TOO_BIG" ou "ERR:<mensagem>".
  public static string Recycle(string path) {
    string result = "ERR:nao executado";
    Thread t = new Thread(delegate () {
      try {
        IIacShellItem item;
        SHCreateItemFromParsingName(path, IntPtr.Zero, typeof(IIacShellItem).GUID, out item);
        IIacFileOperation op = (IIacFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3ad05575-8857-4850-9277-11b85bdb8e09")));
        // FOF_NO_UI (0x614) | FOF_ALLOWUNDO (0x40) | FOFX_RECYCLEONDELETE (0x80000)
        op.SetOperationFlags(0x614 | 0x40 | 0x80000);
        IacTrashSink sink = new IacTrashSink();
        op.DeleteItem(item, sink);
        int hr = op.PerformOperations();
        bool aborted = false;
        try { aborted = op.GetAnyOperationsAborted(); } catch { }
        if (sink.WouldNuke) result = "TOO_BIG";
        else if (hr < 0) result = "ERR:0x" + hr.ToString("X8");
        else if (aborted) result = "ERR:operacao cancelada pelo Windows";
        else if (sink.DeleteResult < 0) result = "ERR:0x" + sink.DeleteResult.ToString("X8");
        else result = "OK";
      } catch (Exception e) { result = "ERR:" + e.Message; }
    });
    t.SetApartmentState(ApartmentState.STA);
    t.Start();
    t.Join();
    return result;
  }
}
`
    const script = `$ErrorActionPreference = 'Stop'
Remove-Item Env:LIB -ErrorAction SilentlyContinue
$IacTrashCs = @'
${TRASH_CS}
'@
try {
  if (-not ('IacTrash' -as [type])) { Add-Type -TypeDefinition $IacTrashCs -IgnoreWarnings -WarningAction SilentlyContinue }
  $p = ${psQuote(p)}
  if (-not (Test-Path -LiteralPath $p)) { 'IAC_TRASH_ERR:o item não existe mais'; return }
  if ($env:IACLEANER_TRASH_SIMULATE_NO_RECYCLE -eq '1') { [IacTrash]::SimulateNoRecycle = $true }
  $r = [IacTrash]::Recycle([System.IO.Path]::GetFullPath($p))
  if ($r -eq 'OK') {
    if (Test-Path -LiteralPath $p) { 'IAC_TRASH_ERR:o Windows não moveu o item (em uso ou sem permissão)' } else { 'IAC_TRASH_OK' }
  } elseif ($r -eq 'TOO_BIG') { 'IAC_TRASH_TOO_BIG' } else { 'IAC_TRASH_' + $r }
} catch { 'IAC_TRASH_ERR:' + $_.Exception.Message }`
    const res = await runPowerShell(script, { timeoutMs: 10 * 60_000 })
    const out = res.stdout
    if (out.includes('IAC_TRASH_OK')) return
    if (out.includes('IAC_TRASH_TOO_BIG')) {
      const e = new Error('TOO_BIG_FOR_RECYCLE: o item não iria para a Lixeira (o Windows apagaria de vez). Nada foi apagado.') as NodeJS.ErrnoException
      e.code = 'ETOOBIGFORRECYCLE'
      throw e
    }
    const msg = /IAC_TRASH_ERR:(.*)/.exec(out)?.[1]?.trim()
    throw new Error(msg || res.stderr.trim() || 'Falha ao mover para a Lixeira')
  }
}

let current: Platform = fallback

export function setPlatform(p: Partial<Platform>): void {
  current = { ...fallback, ...p }
}

export const platform: Platform = {
  // A validação vale para qualquer implementação (Electron ou fallback).
  openExternal: async (u) => current.openExternal(normalizeExternalUrl(u)),
  showInExplorer: (p) => current.showInExplorer(p),
  openPath: (p) => current.openPath(p),
  trashItem: (p) => current.trashItem(p)
}
