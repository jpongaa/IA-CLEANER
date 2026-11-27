<div align="center">

🇺🇸 **English** · 🇧🇷 [Português](README.pt-BR.md)

<img src="build/icon.png" width="96" alt="IA Cleaner" />

# IA Cleaner

**AI-powered PC cleaner, diagnostics and optimizer for Windows — safe by design, and it explains everything.**

IA Cleaner **scans your PC on its own** — drives, junk, games, programs, performance, hardware and drivers.
Then **AI makes sense of it**: what is safe to delete, what you should **not** touch, what it doesn't recognize
(so it searches the web), and what is really slowing your PC down.

[![Download](https://img.shields.io/github/v/release/jpongaa/IA-CLEANER?label=download&color=2ea44f)](../../releases/latest)
![Windows 10/11](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![AI](https://img.shields.io/badge/AI-Claude%20(Anthropic)-D97757)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

</div>

> **The AI only recommends.** Nothing is deleted, uninstalled or changed until you confirm it on screen — and every action is logged in History.

> 🇧🇷 The app's interface is in **Brazilian Portuguese**.

---

## ✨ Features

| Screen | What it does |
|---|---|
| **Dashboard** | PC health score and a read-only **Full Checkup**: drives, recoverable space and top issues. |
| **Disk Analysis** | Fast scan of every HDD/SSD: folder map, biggest files, forgotten files, usage by type and **duplicates**. Includes **"Everything you can delete"**: one list with everything, where the AI labels each item — *Safe to delete*, *Better keep it* or *Don't know what this is* (and then researches it). |
| **Smart Cleanup** | Caches, temp files, dumps, leftover driver installers, Windows Update cache and an **extreme search** (emulator virtual disks, huge app caches…), sorted into *Safe / Review / Keep*. |
| **Deep Search** | Finds what got lost: **leftovers from uninstalled programs**, forgotten installers in Downloads, `.zip`/`.rar` files you already extracted, programs without an uninstaller and unwanted software. |
| **Games & Programs** | Every game (Steam, Epic, EA, Ubisoft, Battle.net, GOG, Xbox, Riot…) and program, with size, **last used** and playtime. Uninstalls through the official uninstaller. |
| **Performance** | Shows **why your PC is slow** (startup apps, RAM/XMP, full system drive, heavy processes, power plan, duplicate antivirus…) and has **Optimize everything**, with Undo and a restore point. |
| **Fix Errors** | Real Windows problems (broken shortcuts, orphaned entries, disk/hardware errors in the event log), with safe fixes and Undo. |
| **Hardware** | CPU-Z style: CPU, motherboard, memory, GPU, drives, monitors — with a **live monitor**. |
| **Drivers** | Driver versions and age, devices with errors, and links to **official vendor sites only**. The AI can look up the latest version. |
| **AI Assistant** | Chat about your PC: *"is more RAM worth it?"*, *"which games can I uninstall?"*… |
| **History** | Everything the app did, with space freed and **Undo**. |

## 📥 Download

1. Grab the latest version from **[Releases](../../releases/latest)**:
   - `IA-Cleaner-Setup-x.y.z.exe` — installs the app and creates shortcuts;
   - `IA-Cleaner-Portable-x.y.z.exe` — runs without installing.
2. The executable is not code-signed, so Windows SmartScreen may say *"Windows protected your PC"*.
   Click **More info → Run anyway**.

Prefer to build it yourself? See [For developers](#-for-developers).

## 🔑 Bring your own AI key

IA Cleaner **ships with no API key**: everyone uses **their own Anthropic (Claude) API key** and pays only for what they use.
Without a key, everything else still works — only the AI analyses are turned off.

1. Create an account at <https://console.anthropic.com>, add credits under *Plans & Billing* and create a key under *API Keys*.
2. In the app: **Configurações (Settings) → Chave da API (API key)** → paste the key → **Salvar chave (Save)** → **Testar conexão (Test connection)** — the test costs nothing.
3. Pick a model:

   | Model | Best for |
   |---|---|
   | **Claude Opus 5.5** | Recommended — the most thorough analyses (≈ US$ 0.15 per analysis) |
   | **Claude Sonnet 5.5** | Cheaper, still very good |
   | **Claude Haiku 5.5** | Fastest and most economical |

Prefer environment variables? Set `ANTHROPIC_API_KEY` before starting the app (a key saved in Settings takes priority).

## 🔒 Privacy & safety

- **Your key stays on your PC**, encrypted by Windows (DPAPI), and is never shown again.
- **Only names, sizes and specs are sent to the AI** — never the contents of your files.
  With *Anonymize paths* on, `C:\Users\<your name>` becomes `%USERPROFILE%`.
- The AI talks **only** to the official Anthropic API (`api.anthropic.com`). No backend server, no sign-up, no telemetry.
- **Deletion guard:** every deletion goes through it. It blocks Windows, Program Files, ProgramData, drive roots, your
  profile structure, installed game/program folders, pagefile/hiberfil, and junctions/symlinks.
- **Prefetch and the Windows Installer cache are never cleaned** — deleting them makes the PC slower or breaks updates.
- **No snake oil:** no "RAM boosters", miracle registry cleaners or third-party driver updaters.

## 🤔 Why didn't deleting files make my PC faster?

Free space is not speed: caches exist to **speed things up**, and they grow back after you delete them. Cleaning only
really helps when the **Windows drive is almost full** (less than 10–15% free). What usually slows a PC down is:
apps launching at startup, too little RAM or RAM running below its rated speed, a full system drive, Windows not
restarted for days, duplicate antivirus, outdated drivers, overheating and games installed on a mechanical HDD.
The **Performance** screen measures all of this on your PC.

---

## 🛠 For developers

**Requirements:** Windows 10/11, **Node 22+** and the **.NET 8 SDK** (for the fast disk-scanning helper).

```powershell
git clone https://github.com/jpongaa/IA-CLEANER.git
cd IA-CLEANER
npm install
npm run build:scanner    # builds native/scanner -> resources/bin/iacleaner-scanner.exe (optional: without it the app uses a slower mode)
npm run dev              # runs the app in development mode
npm run typecheck        # type-checks everything
npm run dist             # builds the installer and the portable exe into dist\
```

Backend tests (read-only; the AI tests use a local fake server and cost nothing):

```powershell
npx tsx --tsconfig tsconfig.node.json scripts/smoke/run.ts cleanup-guard
```

Architecture, safety rules and conventions: [CONTRIBUTING.md](CONTRIBUTING.md).

**Stack:** Electron 44 · electron-vite · React 19 · TypeScript · Tailwind 4 · recharts · lucide-react · zod ·
official Anthropic SDK · a C# (.NET 8) helper for fast disk scanning.

## 🤝 Contributing

Issues and pull requests are welcome! Before touching anything that deletes or changes the PC, read the safety rules in
[CONTRIBUTING.md](CONTRIBUTING.md).

## ⚠️ Disclaimer

Use at your own risk. The app is built to be conservative, but no cleaner replaces a backup — keep copies of what
matters. This project is not affiliated with Anthropic or any vendor mentioned.

## 📄 License

[MIT](LICENSE)
