// Alvos que exigem administrador: TODOS rodam juntos num único script elevado (um só prompt de UAC).
// As raízes já foram validadas pelo guard (checkTargetRoot) ANTES de entrar aqui.
//
// SEGURANÇA (fronteira de privilégio): várias raízes (C:\Windows\Temp, WER, NV_Cache) aceitam pastas criadas por
// usuários comuns. Um processo sem privilégio poderia trocar uma subpasta por uma junction ENTRE a listagem e a
// exclusão, e o processo de administrador apagaria arquivos fora do alvo. Por isso a exclusão elevada NÃO é feita
// por nome (PowerShell/.NET): um módulo C# (compilado com Add-Type) trabalha só com HANDLES:
//  - a raiz é aberta sem seguir pontos de nova análise (FILE_FLAG_OPEN_REPARSE_POINT); é recusada se for atalho
//    ou se o caminho final do handle não for o caminho validado (alguma pasta do caminho virou atalho);
//  - cada item é aberto RELATIVO ao handle da pasta pai (NtOpenFile + RootDirectory, FILE_OPEN_REPARSE_POINT) e os
//    atributos são conferidos de novo NO HANDLE aberto: atalho = pulado (nunca seguido nem apagado);
//  - pastas ficam abertas sem FILE_SHARE_DELETE enquanto são percorridas (ninguém consegue renomeá-las/trocá-las);
//  - a exclusão é feita pelo handle (FileDispositionInfoEx), nunca reabrindo pelo nome.
// Se o módulo não puder ser preparado, os itens de exclusão falham fechados (nada é apagado).
// O script segue as regras do motor Node: nunca apaga a raiz, respeita idade/filtro/profundidade e pula o que está
// em uso.
//
// SEGURANÇA (compilação): o Add-Type grava o .cs, o .cmdline e a .dll em %TEMP% e chama o csc.exe. No processo
// elevado esse %TEMP% é o do usuário (gravável sem administrador): um processo comum poderia trocar o .cs entre a
// gravação e a compilação e rodar código como Administrador. Por isso, só durante o Add-Type, TMP/TEMP apontam para
// uma pasta NOVA e exclusiva em <Windows>\Temp\iac-<guid>, criada já com ACL protegida (sem herança) que só dá
// acesso a SYSTEM e Administradores, com dono Administradores, conferida (não é atalho, dono/ACL exatos, vazia)
// antes do uso e apagada no fim. Qualquer falha nesses passos = nada é apagado (fail-closed).
//
// Busca extrema (comandos OFICIAIS do Windows; nada é apagado por nome pelo app):
//  - cleanmgr: grava StateFlags<N>=2 SÓ nas categorias escolhidas (apaga a mesma flag de todas as outras antes) e roda
//    "cleanmgr /sagerun:<N>"; no fim apaga a flag de todas as categorias (não deixa configuração para trás);
//  - dism: "DISM /Online /Cleanup-Image /StartComponentCleanup" (com /ResetBase só se esse item foi escolhido);
//  - driverStore: "pnputil /delete-driver oemNN.inf" SEM /force e SEM /uninstall, depois de conferir de novo (na hora,
//    como administrador) que o pacote existe e que nenhum dispositivo o usa.
// Modo dryRun (testes): nada é executado nem gravado no registro; o script só devolve os comandos que rodaria.
import { runPowerShellElevated, type ElevatedResult } from '../core/powershell'
import { CLEANMGR_CATEGORIES } from './extreme'

export interface AdminTask {
  id: string
  /**
   * contents = conteúdo de pastas; file = arquivo solto; windowsUpdate = pausa serviços + limpa;
   * deliveryOptimization = comando oficial; cleanmgr / dism / driverStore = Busca extrema (comandos oficiais)
   */
  op: 'contents' | 'file' | 'windowsUpdate' | 'deliveryOptimization' | 'cleanmgr' | 'dism' | 'driverStore'
  roots: string[]
  olderThanDays?: number
  include?: string[]
  /** -1 = sem limite */
  maxDepth?: number
  /** cleanmgr: categorias de VolumeCaches (só as da lista oficial do app) */
  categories?: string[]
  /** dism: inclui /ResetBase */
  resetBase?: boolean
  /** driverStore: pacotes a remover (oemNN.inf), com a pasta do repositório e o tamanho medidos na análise */
  drivers?: { inf: string; folder: string; bytes: number }[]
}

export interface AdminTaskResult {
  id: string
  bytes: number
  files: number
  skipped: number
  errors: string[]
  /** Só no dryRun: comandos que seriam executados */
  planned?: string[]
}

/** Número da configuração da Limpeza de Disco usada pelo app (StateFlags1717 / cleanmgr /sagerun:1717). */
export const CLEANMGR_SAGE_ID = '1717'
const CLEANMGR_ALLOWED = Object.values(CLEANMGR_CATEGORIES)

/** Normaliza/valida os campos dos comandos oficiais (nada fora do esperado entra no script). */
export function sanitizeAdminTask(t: AdminTask): AdminTask {
  const out: AdminTask = { ...t, roots: Array.isArray(t.roots) ? t.roots.map(String) : [] }
  if (t.op === 'cleanmgr') out.categories = [...new Set((t.categories ?? []).filter((c) => CLEANMGR_ALLOWED.includes(c)))]
  if (t.op === 'dism') out.resetBase = t.resetBase === true
  if (t.op === 'driverStore') {
    out.drivers = (t.drivers ?? [])
      .filter((d) => d && /^oem\d+\.inf$/i.test(String(d.inf)) && /^[\w.\-]+$/.test(String(d.folder)))
      .map((d) => ({ inf: String(d.inf).toLowerCase(), folder: String(d.folder), bytes: Math.max(0, Number(d.bytes) || 0) }))
  }
  return out
}

// C# 5 (compilador do .NET Framework do Windows): sem interpolação de strings, "?.", "out var" etc.
const CS_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public class IacStat {
  public double Bytes;
  public int Files;
  public int Skipped;
  public List<string> Errors = new List<string>();
  public void AddError(string m) { if (Errors.Count < 20) Errors.Add(m); }
}

public static class IacSafeDelete {
  // Testes: chamado com o caminho de cada item logo ANTES de ele ser aberto (para simular troca por junction).
  public static Action<string> Hook;

  const uint DELETE = 0x00010000, SYNCHRONIZE = 0x00100000, FILE_LIST_DIRECTORY = 0x1, FILE_READ_ATTRIBUTES = 0x80, FILE_WRITE_ATTRIBUTES = 0x100;
  const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, FILE_SHARE_DELETE = 4;
  const uint FILE_DIRECTORY_FILE = 0x1, FILE_SYNCHRONOUS_IO_NONALERT = 0x20, FILE_NON_DIRECTORY_FILE = 0x40, FILE_OPEN_FOR_BACKUP_INTENT = 0x4000, FILE_OPEN_REPARSE_POINT = 0x200000;
  const uint OBJ_CASE_INSENSITIVE = 0x40;
  const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000, FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000, OPEN_EXISTING = 3;
  const uint ATTR_READONLY = 0x1, ATTR_DIRECTORY = 0x10, ATTR_NORMAL = 0x80, ATTR_REPARSE = 0x400;
  const int FileBasicInfo = 0, FileStandardInfo = 1, FileDispositionInfo = 4, FileAttributeTagInfo = 9;
  const int FileFullDirectoryInfo = 14, FileFullDirectoryRestartInfo = 15, FileDispositionInfoEx = 21;
  const int ERROR_FILE_NOT_FOUND = 2, ERROR_PATH_NOT_FOUND = 3, ERROR_NO_MORE_FILES = 18, ERROR_DIR_NOT_EMPTY = 145;

  [StructLayout(LayoutKind.Sequential)]
  struct UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)]
  struct OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_STATUS_BLOCK { public IntPtr Status; public IntPtr Information; }

  [DllImport("ntdll.dll")]
  static extern int NtOpenFile(out IntPtr handle, uint access, ref OBJECT_ATTRIBUTES oa, out IO_STATUS_BLOCK iosb, uint share, uint options);
  [DllImport("ntdll.dll")]
  static extern int RtlNtStatusToDosError(int status);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int cls, IntPtr buf, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle h, int cls, IntPtr buf, uint size);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder buf, uint size, uint flags);

  class Entry { public string Name; public uint Attributes; }
  class Info { public uint Attributes; public long Created; public long Written; public long Size; public bool IsDir; }

  static string Msg(int err) { return new Win32Exception(err).Message; }

  static Info Query(SafeFileHandle h) {
    IntPtr buf = Marshal.AllocHGlobal(64);
    try {
      if (!GetFileInformationByHandleEx(h, FileAttributeTagInfo, buf, 8)) return null;
      Info i = new Info();
      i.Attributes = (uint)Marshal.ReadInt32(buf, 0);
      if (!GetFileInformationByHandleEx(h, FileBasicInfo, buf, 40)) return null;
      i.Created = Marshal.ReadInt64(buf, 0);
      i.Written = Marshal.ReadInt64(buf, 16);
      if (!GetFileInformationByHandleEx(h, FileStandardInfo, buf, 24)) return null;
      i.Size = Marshal.ReadInt64(buf, 8);
      i.IsDir = Marshal.ReadByte(buf, 21) != 0;
      return i;
    } finally { Marshal.FreeHGlobal(buf); }
  }

  static string FinalPath(SafeFileHandle h) {
    StringBuilder sb = new StringBuilder(1024);
    uint n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0);
    if (n == 0) return null;
    if (n >= sb.Capacity) { sb = new StringBuilder((int)n + 1); n = GetFinalPathNameByHandleW(h, sb, (uint)sb.Capacity, 0); if (n == 0) return null; }
    string s = sb.ToString();
    if (s.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return null;
    if (s.StartsWith(@"\\?\")) s = s.Substring(4);
    return s;
  }

  // Abre um item RELATIVO ao handle da pasta pai, sem seguir pontos de nova análise. Pasta sem permissão de
  // exclusão: abre só para listar (o conteúdo ainda pode ser limpo; a pasta em si fica).
  static SafeFileHandle OpenChild(SafeFileHandle parent, string name, bool dir, out int error) {
    SafeFileHandle h = OpenChild(parent, name, dir, true, out error);
    if (h == null && dir && error == 5) h = OpenChild(parent, name, dir, false, out error);
    return h;
  }

  static SafeFileHandle OpenChild(SafeFileHandle parent, string name, bool dir, bool forDelete, out int error) {
    IntPtr nameBuf = Marshal.StringToHGlobalUni(name);
    IntPtr usPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
    bool added = false;
    try {
      parent.DangerousAddRef(ref added);
      UNICODE_STRING us = new UNICODE_STRING();
      us.Length = (ushort)(name.Length * 2);
      us.MaximumLength = (ushort)(name.Length * 2 + 2);
      us.Buffer = nameBuf;
      Marshal.StructureToPtr(us, usPtr, false);
      OBJECT_ATTRIBUTES oa = new OBJECT_ATTRIBUTES();
      oa.Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES));
      oa.RootDirectory = parent.DangerousGetHandle();
      oa.ObjectName = usPtr;
      oa.Attributes = OBJ_CASE_INSENSITIVE;
      uint access = SYNCHRONIZE | FILE_READ_ATTRIBUTES | (forDelete ? (DELETE | FILE_WRITE_ATTRIBUTES) : 0) | (dir ? FILE_LIST_DIRECTORY : 0);
      // Pastas: sem FILE_SHARE_DELETE, ninguém renomeia/troca a pasta enquanto ela está sendo percorrida.
      uint share = dir ? (FILE_SHARE_READ | FILE_SHARE_WRITE) : (FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
      uint options = FILE_OPEN_REPARSE_POINT | FILE_OPEN_FOR_BACKUP_INTENT | FILE_SYNCHRONOUS_IO_NONALERT | (dir ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE);
      IntPtr h;
      IO_STATUS_BLOCK io;
      int st = NtOpenFile(out h, access, ref oa, out io, share, options);
      if (st < 0) { error = RtlNtStatusToDosError(st); return null; }
      error = 0;
      return new SafeFileHandle(h, true);
    } finally {
      if (added) parent.DangerousRelease();
      Marshal.FreeHGlobal(usPtr);
      Marshal.FreeHGlobal(nameBuf);
    }
  }

  static List<Entry> ListDir(SafeFileHandle dir, out int error) {
    List<Entry> list = new List<Entry>();
    const int size = 64 * 1024;
    IntPtr buf = Marshal.AllocHGlobal(size);
    error = 0;
    try {
      bool first = true;
      while (true) {
        if (!GetFileInformationByHandleEx(dir, first ? FileFullDirectoryRestartInfo : FileFullDirectoryInfo, buf, size)) {
          int e = Marshal.GetLastWin32Error();
          if (e != ERROR_NO_MORE_FILES) error = e;
          break;
        }
        first = false;
        long off = 0;
        while (true) {
          IntPtr p = new IntPtr(buf.ToInt64() + off);
          int next = Marshal.ReadInt32(p, 0);
          uint attrs = (uint)Marshal.ReadInt32(p, 56);
          int nameLen = Marshal.ReadInt32(p, 60);
          string name = Marshal.PtrToStringUni(new IntPtr(p.ToInt64() + 68), nameLen / 2);
          if (name != "." && name != "..") { Entry en = new Entry(); en.Name = name; en.Attributes = attrs; list.Add(en); }
          if (next == 0) break;
          off += next;
        }
      }
    } finally { Marshal.FreeHGlobal(buf); }
    return list;
  }

  // Apaga pelo handle. Arquivos somente-leitura: flag IGNORE_READONLY (ou tira o atributo no modo clássico).
  static bool MarkDelete(SafeFileHandle h, uint attrs, bool isDir, out int error) {
    IntPtr buf = Marshal.AllocHGlobal(40);
    try {
      Marshal.WriteInt32(buf, 0, 0x1 | 0x2 | 0x10); // DELETE | POSIX_SEMANTICS | IGNORE_READONLY_ATTRIBUTE
      if (SetFileInformationByHandle(h, FileDispositionInfoEx, buf, 4)) { error = 0; return true; }
      error = Marshal.GetLastWin32Error();
      if (error == ERROR_DIR_NOT_EMPTY || error == 32) return false;
      bool clearedRo = false;
      if (!isDir && (attrs & ATTR_READONLY) != 0) {
        for (int k = 0; k < 40; k++) Marshal.WriteByte(buf, k, 0);
        uint na = attrs & ~(ATTR_READONLY | ATTR_REPARSE | ATTR_DIRECTORY);
        Marshal.WriteInt32(buf, 32, (int)(na == 0 ? ATTR_NORMAL : na));
        clearedRo = SetFileInformationByHandle(h, FileBasicInfo, buf, 40);
      }
      Marshal.WriteInt32(buf, 0, 1);
      if (SetFileInformationByHandle(h, FileDispositionInfo, buf, 4)) { error = 0; return true; }
      error = Marshal.GetLastWin32Error();
      if (clearedRo) {
        for (int k = 0; k < 40; k++) Marshal.WriteByte(buf, k, 0);
        Marshal.WriteInt32(buf, 32, (int)(attrs & ~(ATTR_REPARSE | ATTR_DIRECTORY)));
        SetFileInformationByHandle(h, FileBasicInfo, buf, 40);
      }
      return false;
    } finally { Marshal.FreeHGlobal(buf); }
  }

  static Regex[] Compile(string[] patterns) {
    List<Regex> list = new List<Regex>();
    if (patterns != null) {
      foreach (string p in patterns) {
        if (String.IsNullOrEmpty(p)) continue;
        string body = Regex.Escape(p).Replace(@"\*", ".*").Replace(@"\?", ".");
        list.Add(new Regex("^" + body + "$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant));
      }
    }
    return list.ToArray();
  }

  static bool Matches(string name, Regex[] include) {
    if (include.Length == 0) return true;
    foreach (Regex r in include) if (r.IsMatch(name)) return true;
    return false;
  }

  // Abre a RAIZ pelo caminho validado: sem seguir atalhos, e o caminho final do handle tem que ser o mesmo.
  static SafeFileHandle OpenRoot(string root, bool dir, IacStat stat) {
    string full = System.IO.Path.GetFullPath(root).TrimEnd('\\');
    uint access = FILE_READ_ATTRIBUTES | SYNCHRONIZE | (dir ? FILE_LIST_DIRECTORY : (DELETE | FILE_WRITE_ATTRIBUTES));
    uint share = dir ? (FILE_SHARE_READ | FILE_SHARE_WRITE) : (FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
    SafeFileHandle h = CreateFileW(@"\\?\" + full, access, share, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (h.IsInvalid) {
      int e = Marshal.GetLastWin32Error();
      h.Dispose();
      if (e != ERROR_FILE_NOT_FOUND && e != ERROR_PATH_NOT_FOUND) { stat.Skipped++; stat.AddError(root + " : " + Msg(e)); }
      return null;
    }
    Info info = Query(h);
    if (info == null || (info.Attributes & ATTR_REPARSE) != 0 || info.IsDir != dir) {
      h.Dispose();
      stat.Skipped++;
      stat.AddError(root + " é um atalho (junction/link) ou mudou de tipo; ignorado.");
      return null;
    }
    string fin = FinalPath(h);
    if (fin == null || !String.Equals(fin.TrimEnd('\\'), full, StringComparison.OrdinalIgnoreCase)) {
      h.Dispose();
      stat.Skipped++;
      stat.AddError(root + " : o caminho real (" + fin + ") é diferente do validado (uma pasta do caminho virou atalho); ignorado.");
      return null;
    }
    return h;
  }

  // Devolve true se a pasta ficou vazia. Nunca segue nem apaga pontos de nova análise (junctions/links).
  static bool ClearDir(SafeFileHandle dir, string path, int depth, int maxDepth, long cutoff, Regex[] include, bool removeEmpty, IacStat stat) {
    int err;
    List<Entry> items = ListDir(dir, out err);
    if (err != 0) { stat.Skipped++; return false; }
    int remaining = items.Count;
    foreach (Entry e in items) {
      string full = path + "\\" + e.Name;
      if ((e.Attributes & ATTR_REPARSE) != 0) { stat.Skipped++; continue; }
      bool isDir = (e.Attributes & ATTR_DIRECTORY) != 0;
      if (isDir && maxDepth >= 0 && depth >= maxDepth) continue;
      if (!isDir && !Matches(e.Name, include)) continue;
      if (Hook != null) Hook(full);
      SafeFileHandle h = OpenChild(dir, e.Name, isDir, out err);
      if (h == null) {
        if (err == ERROR_FILE_NOT_FOUND || err == ERROR_PATH_NOT_FOUND) remaining--;
        else stat.Skipped++;
        continue;
      }
      using (h) {
        // Confere de novo NO HANDLE: se o item virou atalho ou mudou de tipo depois da listagem, não mexe.
        Info info = Query(h);
        if (info == null || (info.Attributes & ATTR_REPARSE) != 0 || info.IsDir != isDir) { stat.Skipped++; continue; }
        long age = Math.Max(info.Created, info.Written);
        if (isDir) {
          bool empty = ClearDir(h, full, depth + 1, maxDepth, cutoff, include, removeEmpty, stat);
          if (empty && removeEmpty && (cutoff == 0 || age < cutoff)) {
            if (MarkDelete(h, info.Attributes, true, out err)) remaining--;
          }
        } else {
          if (cutoff != 0 && age >= cutoff) continue;
          if (MarkDelete(h, info.Attributes, false, out err)) { stat.Bytes += info.Size; stat.Files++; remaining--; }
          else stat.Skipped++;
        }
      }
    }
    return remaining == 0;
  }

  // cutoff: FILETIME UTC (0 = sem filtro de idade). maxDepth: -1 = sem limite.
  public static void ClearContents(string root, long cutoff, string[] include, int maxDepth, bool removeEmpty, IacStat stat) {
    SafeFileHandle h = OpenRoot(root, true, stat);
    if (h == null) return;
    using (h) { ClearDir(h, System.IO.Path.GetFullPath(root).TrimEnd('\\'), 0, maxDepth, cutoff, Compile(include), removeEmpty, stat); }
  }

  public static void DeleteFile(string file, IacStat stat) {
    SafeFileHandle h = OpenRoot(file, false, stat);
    if (h == null) return;
    using (h) {
      Info info = Query(h);
      int err;
      if (info != null && MarkDelete(h, info.Attributes, false, out err)) { stat.Bytes += info.Size; stat.Files++; }
      else { stat.Skipped++; stat.AddError(file + " : não foi possível apagar (em uso ou sem permissão)."); }
    }
  }
}
`

const PS_FUNCTIONS = String.raw`
$IacCs = @'
${CS_SOURCE}
'@

# Nenhuma pasta do caminho (da própria até a raiz) pode ser atalho (junction, link simbólico, ponto de montagem).
function Test-IacNoReparse([string]$p) {
  # GetDirectoryName: 'C:\a\b' -> 'C:\a' -> 'C:\' -> $null
  $cur = [System.IO.Path]::GetFullPath($p)
  while ($cur) {
    $attr = [System.IO.File]::GetAttributes($cur)
    if (($attr -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { return $false }
    $cur = [System.IO.Path]::GetDirectoryName($cur)
  }
  return $true
}

# Cria a pasta temporária PRIVADA do compilador: nova (nome aleatório), criada já com dono e ACL protegida (sem
# herança) e conferida antes do uso. Devolve o caminho; qualquer falha lança (e o chamador falha fechado).
function New-IacPrivateTemp {
  $base = [string]$IacCompileBase
  if (-not $base) { $base = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)) 'Temp' }
  if (-not [System.IO.Path]::IsPathRooted($base) -or $base.StartsWith('\\')) { throw "pasta-base inválida ($base)" }
  $base = [System.IO.Path]::GetFullPath($base).TrimEnd('\')
  if (-not [System.IO.Directory]::Exists($base)) { throw "a pasta $base não existe" }
  if (-not (Test-IacNoReparse $base)) { throw "a pasta $base passa por um atalho (junction/link)" }
  $owner = [string]$IacCompileOwner
  $trustees = @($IacCompileTrustees | ForEach-Object { [string]$_ })
  if (-not $owner -or $trustees.Count -eq 0) { throw 'ACL da pasta temporária não definida' }
  $dir = Join-Path $base ('iac-' + [guid]::NewGuid().ToString('N'))
  if ([System.IO.Directory]::Exists($dir) -or [System.IO.File]::Exists($dir)) { throw 'a pasta temporária já existia' }
  # O (dono), D:PAI = ACL protegida (não herda nada da pasta pai); só os SIDs abaixo, controle total.
  $sddl = 'O:' + $owner + 'D:PAI' + (($trustees | ForEach-Object { '(A;OICI;FA;;;' + $_ + ')' }) -join '')
  $sec = New-Object System.Security.AccessControl.DirectorySecurity
  $sec.SetSecurityDescriptorSddlForm($sddl)
  [void][System.IO.Directory]::CreateDirectory($dir, $sec)
  $ok = $false
  try {
    $attr = [System.IO.File]::GetAttributes($dir)
    if (($attr -band [System.IO.FileAttributes]::Directory) -eq 0 -or ($attr -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'a pasta temporária não é uma pasta comum' }
    if (-not (Test-IacNoReparse $dir)) { throw 'a pasta temporária passa por um atalho' }
    $acl = [System.IO.Directory]::GetAccessControl($dir)
    $realOwner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    if ($realOwner -ne $owner) { throw "a pasta temporária tem outro dono ($realOwner)" }
    if (-not $acl.AreAccessRulesProtected) { throw 'a pasta temporária herdou permissões' }
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if ($rules.Count -eq 0) { throw 'a pasta temporária ficou sem permissões' }
    foreach ($r in $rules) {
      if ($r.IsInherited -or [string]$r.AccessControlType -ne 'Allow' -or $trustees -notcontains $r.IdentityReference.Value) {
        throw "permissão inesperada na pasta temporária ($($r.IdentityReference.Value))"
      }
    }
    if (@([System.IO.Directory]::GetFileSystemEntries($dir)).Count -ne 0) { throw 'a pasta temporária não está vazia' }
    $ok = $true
    return $dir
  } finally {
    # Não conferida: não mexe em nada dentro dela (pode não ser nossa); só tenta remover a pasta se estiver vazia.
    if (-not $ok) { try { [System.IO.Directory]::Delete($dir, $false) } catch { } }
  }
}

# Apaga a pasta privada (já conferida): só arquivos comuns do primeiro nível, depois a pasta (se vazia).
function Remove-IacPrivateTemp([string]$dir) {
  if (-not $dir) { return }
  try {
    foreach ($f in @([System.IO.Directory]::GetFiles($dir))) {
      try { if (([System.IO.File]::GetAttributes($f) -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) { [System.IO.File]::Delete($f) } } catch { }
    }
  } catch { }
  try { [System.IO.Directory]::Delete($dir, $false) } catch { }
}

# Compila o módulo de exclusão segura (por handle). Falha = nada é apagado (fail-closed).
function Initialize-IacSafeDelete {
  if ('IacSafeDelete' -as [type]) { return '' }
  $private = $null
  try {
    # LIB apontando para pasta inexistente quebra a compilação (Add-Type)
    Remove-Item Env:LIB -ErrorAction SilentlyContinue
    $private = New-IacPrivateTemp
    $oldTmp = [Environment]::GetEnvironmentVariable('TMP', 'Process')
    $oldTemp = [Environment]::GetEnvironmentVariable('TEMP', 'Process')
    try {
      [Environment]::SetEnvironmentVariable('TMP', $private, 'Process')
      [Environment]::SetEnvironmentVariable('TEMP', $private, 'Process')
      $tp = [System.IO.Path]::GetTempPath().TrimEnd('\')
      if ($tp -ne $private) { throw "o Windows não usou a pasta temporária privada ($tp)" }
      Add-Type -TypeDefinition $IacCs -IgnoreWarnings -ErrorAction Stop -WarningAction SilentlyContinue
    } finally {
      [Environment]::SetEnvironmentVariable('TMP', $oldTmp, 'Process')
      [Environment]::SetEnvironmentVariable('TEMP', $oldTemp, 'Process')
    }
    if (-not ('IacSafeDelete' -as [type])) { throw 'o módulo não foi carregado' }
    return ''
  } catch {
    return [string]$_.Exception.Message
  } finally {
    if ($private) { Remove-IacPrivateTemp $private }
  }
}

function New-IacStat {
  if ('IacStat' -as [type]) { return (New-Object IacStat) }
  return @{ bytes = [double]0; files = 0; skipped = 0; errors = (New-Object System.Collections.ArrayList) }
}

function Invoke-IacContents($t, $stat) {
  $cutoff = [long]0
  if ($t.olderThanDays -gt 0) { $cutoff = (Get-Date).AddDays(-1 * [double]$t.olderThanDays).ToFileTimeUtc() }
  $patterns = [string[]]@($t.include | Where-Object { $_ } | ForEach-Object { [string]$_ })
  $removeEmpty = ($patterns.Count -eq 0)
  foreach ($r in @($t.roots)) {
    try { [IacSafeDelete]::ClearContents([string]$r, [long]$cutoff, $patterns, [int]$t.maxDepth, [bool]$removeEmpty, $stat) }
    catch { $stat.AddError("$r : $($_.Exception.Message)") }
  }
}

function Invoke-IacFile($t, $stat) {
  foreach ($r in @($t.roots)) {
    try { [IacSafeDelete]::DeleteFile([string]$r, $stat) }
    catch { $stat.Skipped++; $stat.AddError("$r : $($_.Exception.Message)") }
  }
}

function Invoke-IacWindowsUpdate($t, $stat) {
  if (@(Get-Process -Name 'TiWorker' -ErrorAction SilentlyContinue).Count -gt 0) {
    [void]$stat.errors.Add('O Windows está instalando atualizações agora. Tente de novo mais tarde.')
    return
  }
  $services = @('wuauserv', 'bits')
  $wasRunning = @{}
  try {
    foreach ($s in $services) {
      $svc = Get-Service -Name $s -ErrorAction SilentlyContinue
      if ($svc -and $svc.Status -eq 'Running') {
        $wasRunning[$s] = $true
        Stop-Service -Name $s -Force -ErrorAction Stop -WarningAction SilentlyContinue
      }
    }
    foreach ($s in $services) {
      try { (Get-Service -Name $s -ErrorAction Stop).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) } catch { }
    }
    Invoke-IacContents $t $stat
  } catch {
    [void]$stat.errors.Add("Não foi possível pausar o Windows Update: $($_.Exception.Message)")
  } finally {
    foreach ($s in @('bits', 'wuauserv')) {
      if ($wasRunning[$s]) {
        try { Start-Service -Name $s -ErrorAction Stop -WarningAction SilentlyContinue } catch { [void]$stat.errors.Add("Não foi possível religar o serviço $s ($($_.Exception.Message)). Ele volta sozinho ao reiniciar o PC.") }
      }
    }
  }
}

function Invoke-IacDeliveryOptimization($t, $stat) {
  try {
    $before = [double](Get-DeliveryOptimizationPerfSnap -WarningAction SilentlyContinue -ErrorAction Stop).CacheSizeBytes
    Delete-DeliveryOptimizationCache -Force -ErrorAction Stop -WarningAction SilentlyContinue | Out-Null
    $after = [double](Get-DeliveryOptimizationPerfSnap -WarningAction SilentlyContinue -ErrorAction Stop).CacheSizeBytes
    $stat.bytes = [Math]::Max([double]0, $before - $after)
  } catch { [void]$stat.errors.Add("Otimização de Entrega: $($_.Exception.Message)") }
}

# ---- Busca extrema: comandos oficiais do Windows ----
$IacPlanned = New-Object System.Collections.ArrayList

function Get-IacFreeBytes {
  try { return [double](New-Object System.IO.DriveInfo ([string]$env:SystemDrive)).AvailableFreeSpace } catch { return [double]0 }
}

function Test-IacStop {
  if (Get-Command Test-IacCancel -ErrorAction SilentlyContinue) { return [bool](Test-IacCancel) }
  return $false
}

function Invoke-IacCleanmgr($t, $stat) {
  $base = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\VolumeCaches'
  $flag = 'StateFlags' + $IacSageId
  $exe = Join-Path $env:windir 'System32\cleanmgr.exe'
  $cats = @($t.categories | ForEach-Object { [string]$_ } | Where-Object { $IacCleanmgrAllowed -contains $_ })
  if ($cats.Count -eq 0) { [void]$stat.errors.Add('Nenhuma categoria da Limpeza de Disco foi escolhida.'); return }
  if ($IacDryRun) {
    [void]$IacPlanned.Add('reg: ' + $flag + '=2 somente em [' + ($cats -join ' | ') + '] (a mesma flag é apagada de todas as outras categorias antes e depois)')
    [void]$IacPlanned.Add('"' + $exe + '" /sagerun:' + $IacSageId)
    return
  }
  $all = @(Get-ChildItem -LiteralPath $base -ErrorAction Stop | ForEach-Object { $_.PSChildName })
  $before = Get-IacFreeBytes
  try {
    foreach ($c in $all) { Remove-ItemProperty -LiteralPath (Join-Path $base $c) -Name $flag -ErrorAction SilentlyContinue }
    $set = 0
    foreach ($c in $cats) {
      if ($all -notcontains $c) { [void]$stat.errors.Add('A categoria "' + $c + '" não existe nesta versão do Windows.'); continue }
      New-ItemProperty -LiteralPath (Join-Path $base $c) -Name $flag -Value 2 -PropertyType DWord -Force | Out-Null
      $set++
    }
    if ($set -gt 0) {
      $p = Start-Process -FilePath $exe -ArgumentList ('/sagerun:' + $IacSageId) -PassThru -WindowStyle Hidden
      $deadline = (Get-Date).AddMinutes(45)
      while (-not $p.HasExited) {
        if (Test-IacStop) { [void]$stat.errors.Add('Cancelado: a Limpeza de Disco do Windows termina a etapa atual sozinha.'); break }
        if ((Get-Date) -gt $deadline) { [void]$stat.errors.Add('A Limpeza de Disco passou de 45 minutos e continua em segundo plano.'); break }
        Start-Sleep -Milliseconds 1000
      }
    }
  } catch {
    [void]$stat.errors.Add('Limpeza de Disco: ' + $_.Exception.Message)
  } finally {
    foreach ($c in $all) { Remove-ItemProperty -LiteralPath (Join-Path $base $c) -Name $flag -ErrorAction SilentlyContinue }
  }
  $stat.bytes = [Math]::Max([double]0, (Get-IacFreeBytes) - $before)
}

function Invoke-IacDism($t, $stat) {
  $exe = Join-Path $env:windir 'System32\Dism.exe'
  $dargs = @('/Online', '/Cleanup-Image', '/StartComponentCleanup')
  if ($t.resetBase -eq $true) { $dargs += '/ResetBase' }
  $dargs += '/NoRestart'
  if ($IacDryRun) { [void]$IacPlanned.Add('"' + $exe + '" ' + ($dargs -join ' ')); return }
  $before = Get-IacFreeBytes
  try {
    $out = @(& $exe @dargs 2>&1 | ForEach-Object { [string]$_ })
    $code = $LASTEXITCODE
    if ($code -eq 3010) { [void]$stat.errors.Add('Concluído; o Windows pede para reiniciar o PC para terminar.') }
    elseif ($code -ne 0) {
      $last = @($out | Where-Object { $_.Trim() } | Select-Object -Last 1)
      [void]$stat.errors.Add('O DISM terminou com o código ' + $code + '. ' + ($last -join ''))
    }
  } catch { [void]$stat.errors.Add('DISM: ' + $_.Exception.Message) }
  $stat.bytes = [Math]::Max([double]0, (Get-IacFreeBytes) - $before)
}

function Invoke-IacDriverStore($t, $stat) {
  $pnp = Join-Path $env:windir 'System32\pnputil.exe'
  $repo = Join-Path $env:windir 'System32\DriverStore\FileRepository'
  # Confere de novo, agora: o pacote ainda existe e NENHUM dispositivo o usa.
  $exists = @{}; $inUse = @{}
  try {
    $xml = [xml]((& $pnp /enum-drivers /devices /format xml) -join [string][char]10)
    foreach ($d in @($xml.PnpUtil.Driver)) {
      $n = ([string]$d.DriverName).ToLower()
      $exists[$n] = $true
      if ($d.Devices -and $d.Devices.Device) { $inUse[$n] = $true }
    }
  } catch { [void]$stat.errors.Add('Não foi possível conferir os drivers agora (' + $_.Exception.Message + '). Nada foi removido.'); return }
  foreach ($dv in @($t.drivers)) {
    $inf = ([string]$dv.inf).ToLower()
    if ($inf -notmatch '^oem\d+\.inf$') { $stat.skipped++; continue }
    if (-not $exists[$inf]) { continue }
    if ($inUse[$inf]) { $stat.skipped++; [void]$stat.errors.Add($inf + ' passou a ser usado por um dispositivo: foi mantido.'); continue }
    if ($IacDryRun) { [void]$IacPlanned.Add('"' + $pnp + '" /delete-driver ' + $inf); continue }
    $out = @(& $pnp /delete-driver $inf 2>&1)
    if ($LASTEXITCODE -eq 0) {
      $stat.files++
      $folder = [string]$dv.folder
      if ($folder -and -not (Test-Path -LiteralPath (Join-Path $repo $folder))) { $stat.bytes += [double]$dv.bytes }
    } else {
      $stat.skipped++
      [void]$stat.errors.Add($inf + ': o Windows não removeu (código ' + $LASTEXITCODE + '; em uso ou protegido). Nada foi forçado.')
    }
  }
}
`

/** SYSTEM e Administradores: os únicos com acesso à pasta temporária do compilador (produção). */
const SID_SYSTEM = 'S-1-5-18'
const SID_ADMINISTRATORS = 'S-1-5-32-544'

/**
 * SOMENTE TESTES (sem elevação, numa sandbox): troca a pasta-base e a ACL da pasta temporária privada do
 * compilador. Em produção (runAdminTasks) nada disto é passado: <Windows>\Temp, dono Administradores e acesso só
 * para SYSTEM + Administradores.
 */
export interface AdminScriptTestOptions {
  /** Busca extrema: não executa cleanmgr/DISM/pnputil nem grava no registro; devolve os comandos em `planned`. */
  commandDryRun?: boolean
  compileTempBase?: string
  /** SID exigido como dono da pasta */
  compileOwnerSid?: string
  /** SIDs com controle total (as ÚNICAS entradas da ACL) */
  compileTrusteeSids?: string[]
}

function psLiteral(v: string): string {
  // ‘ ’ ‚ ‛ também fecham literais '...' no PowerShell: dobrar todos (mesma regra do psQuote).
  return `'${v.replace(/['‘’‚‛]/g, (q) => q + q)}'`
}

function sidOrThrow(s: string): string {
  if (!/^S-1-\d+(-\d+)+$/.test(s)) throw new Error(`SID inválido: ${s}`)
  return s
}

/** Monta o script elevado (exportado para testes: o smoke executa SEM elevação, só numa sandbox). */
export function buildAdminScript(tasks: AdminTask[], test: AdminScriptTestOptions = {}): string {
  // JSON numa linha dentro de here-string literal: nada é interpolado pelo PowerShell.
  const json = JSON.stringify(tasks.map(sanitizeAdminTask).map((t) => ({ ...t, include: t.include ?? [], maxDepth: t.maxDepth ?? -1, olderThanDays: t.olderThanDays ?? 0 })))
  const owner = sidOrThrow(test.compileOwnerSid ?? SID_ADMINISTRATORS)
  const trustees = (test.compileTrusteeSids?.length ? test.compileTrusteeSids : [SID_SYSTEM, SID_ADMINISTRATORS]).map(sidOrThrow)
  return `$IacCompileBase = ${test.compileTempBase ? psLiteral(test.compileTempBase) : "''"}
$IacCompileOwner = ${psLiteral(owner)}
$IacCompileTrustees = @(${trustees.map(psLiteral).join(', ')})
$IacDryRun = ${test.commandDryRun ? '$true' : '$false'}
$IacSageId = ${psLiteral(CLEANMGR_SAGE_ID)}
$IacCleanmgrAllowed = @(${CLEANMGR_ALLOWED.map(psLiteral).join(', ')})
${PS_FUNCTIONS}
$IacInitError = Initialize-IacSafeDelete
$parsed = ConvertFrom-Json @'
${json}
'@
# PS 5.1: ConvertFrom-Json devolve o array inteiro como UM objeto; o pipe abaixo enumera os itens.
$tasks = @($parsed | ForEach-Object { $_ })
$results = New-Object System.Collections.ArrayList
foreach ($t in $tasks) {
  $stat = New-IacStat
  $IacPlanned.Clear()
  try {
    $op = [string]$t.op
    if ($op -eq 'deliveryOptimization') {
      Invoke-IacDeliveryOptimization $t $stat
    } elseif ($op -eq 'cleanmgr') {
      Invoke-IacCleanmgr $t $stat
    } elseif ($op -eq 'dism') {
      Invoke-IacDism $t $stat
    } elseif ($op -eq 'driverStore') {
      Invoke-IacDriverStore $t $stat
    } elseif ($IacInitError) {
      [void]$stat.errors.Add("Proteção da exclusão indisponível ($IacInitError). Nada foi apagado neste item.")
    } else {
      switch ($op) {
        'contents' { Invoke-IacContents $t $stat }
        'file' { Invoke-IacFile $t $stat }
        'windowsUpdate' { Invoke-IacWindowsUpdate $t $stat }
        default { [void]$stat.errors.Add('Operação desconhecida.') }
      }
    }
  } catch { [void]$stat.errors.Add($_.Exception.Message) }
  [void]$results.Add([ordered]@{ id = [string]$t.id; bytes = [double]$stat.bytes; files = [int]$stat.files; skipped = [int]$stat.skipped; errors = @($stat.errors | Select-Object -First 20 | ForEach-Object { [string]$_ }); planned = @($IacPlanned | ForEach-Object { [string]$_ }) })
}
ConvertTo-Json -InputObject @($results) -Depth 5 -Compress
`
}

/** Executa os alvos de administrador (abre UM prompt de UAC se o app não estiver elevado). */
export async function runAdminTasks(tasks: AdminTask[], signal?: AbortSignal): Promise<ElevatedResult<AdminTaskResult[]>> {
  if (tasks.length === 0) return { ok: true, cancelled: false, data: [] }
  // Sem opções de teste: pasta privada em <Windows>\Temp, só SYSTEM + Administradores.
  const res = await runPowerShellElevated<AdminTaskResult[] | AdminTaskResult>(buildAdminScript(tasks), { timeoutMs: 45 * 60_000, signal })
  if (!res.ok) return { ok: false, cancelled: res.cancelled, error: res.error }
  const raw = res.data
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  return {
    ok: true,
    cancelled: false,
    data: list.map((r) => ({
      id: String(r.id),
      bytes: Number(r.bytes) || 0,
      files: Number(r.files) || 0,
      skipped: Number(r.skipped) || 0,
      errors: Array.isArray(r.errors) ? r.errors.map(String) : r.errors ? [String(r.errors)] : [],
      planned: Array.isArray(r.planned) ? r.planned.map(String) : r.planned ? [String(r.planned)] : undefined
    }))
  }
}
