// Classificação de arquivos em FileCategory — mesma regra do helper nativo (native/scanner/Categories.cs):
// 1) contexto da pasta (biblioteca de jogos, Windows, Temp) tem prioridade; 2) senão, pela extensão.
import type { FileCategory } from '@shared/types/disk'

const BY_EXT: Record<string, FileCategory> = {}

function add(cat: FileCategory, exts: string): void {
  for (const e of exts.split(/\s+/)) if (e) BY_EXT[e] = cat
}

add('video', 'mp4 mkv avi mov wmv flv webm m4v mpg mpeg m2ts mts 3gp vob ogv rmvb divx')
add('image', 'jpg jpeg png gif bmp webp heic heif tif tiff raw cr2 cr3 nef arw dng psd svg ico avif jfif xcf kra exr hdr')
add('audio', 'mp3 wav flac aac ogg m4a wma opus aiff aif alac mid midi ape')
add('archive', 'zip rar 7z tar gz tgz bz2 xz zst lz lzma cab z01 r00 001')
add('installer', 'msi msix msixbundle appx appxbundle msp msu apk xapk pkg deb rpm esd')
add('diskImage', 'iso img nrg dmg wim swm mdf mds cue ccd toast')
add('virtualDisk', 'vhd vhdx vmdk vdi qcow2 avhdx vmem vmsn vmss hdd nvram')
add('document', 'pdf doc docx xls xlsx xlsm ppt pptx odt ods odp rtf txt md csv epub mobi pages key numbers one pst ost eml msg xps djvu')
add(
  'code',
  'js mjs cjs ts tsx jsx py pyc pyd c cc cpp h hpp cs java class jar go rs rb php lua json xml yml yaml toml html htm css scss sql sqlite db pdb obj o lib a ipch pch node wasm map ps1 psm1 bat cmd sh ipynb whl'
)
add(
  'gameData',
  'pak vpk bundle assets resource ucas utoc forge big bsa ba2 wad esm unity3d bik bk2 usm rpf gcf ncf arc ress sb toc cas dat2 pck pkx xvc sav save uasset umap streamed cpk awb acb wem bnk fsb dds xnb ytd ydr vdf acf rgss3a nsp xci gba nds z64 n64 smc sfc gb gbc cia 3ds wbfs rvz gcm chd pbp cso'
)
add('backup', 'bak old backup bkp bkf tib tibx vbk wbcat gho sbk mrimg orig')
add('log', 'log etl evtx dmp mdmp hdmp trace blf regtrans-ms jrs chk')
add('temp', 'tmp temp crdownload part partial download opdownload !ut dlpart aria2 ~tmp')
add('executable', 'exe dll ocx scr com efi cpl drv winmd msstyles ax')
add('system', 'sys mui cat manifest pf edb dat ini inf pnf nls ttf otf fon ttc cdf-ms mum admx adml tlb rll sdb jfm')

const GAME_DIRS = new Set(
  [
    'steamapps',
    'SteamLibrary',
    'Epic Games',
    'XboxGames',
    'Riot Games',
    'EA Games',
    'Origin Games',
    'GOG Games',
    'GOG Galaxy Games',
    'Ubisoft Game Launcher',
    'Rockstar Games Launcher Games',
    'Battle.net Games',
    'Amazon Games',
    'Games Library'
  ].map((s) => s.toLowerCase())
)
const TEMP_DIRS = new Set(['temp', 'tmp', 'inetcache', 'crashdumps', 'd3dscache', 'dxcache', 'glcache', 'shadercache', 'nv_cache'])

/** Extensão minúscula sem ponto ('' se não houver). */
export function extOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot === fileName.length - 1) return ''
  return fileName.slice(dot + 1).toLowerCase()
}

export function categoryOfExt(ext: string): FileCategory {
  return BY_EXT[ext] ?? 'other'
}

/** Contexto herdado por uma subpasta (null = classificar pela extensão). depth: 1 = filho direto da raiz. */
export function dirContext(name: string, depth: number, parentCtx: FileCategory | null): FileCategory | null {
  if (parentCtx) return parentCtx
  const n = name.toLowerCase()
  if (depth === 1) {
    if (n === 'windows') return 'system'
    if (n === 'windows.old') return 'backup'
    if (n === '$windows.~bt' || n === '$winreagent') return 'temp'
  }
  if (GAME_DIRS.has(n)) return 'gameData'
  if (TEMP_DIRS.has(n)) return 'temp'
  return null
}
