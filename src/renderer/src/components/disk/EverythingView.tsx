// "Tudo que dá para apagar": junta a Limpeza (com a busca extrema), a Busca Profunda e os arquivos grandes esquecidos
// num lugar só, com o veredito de cada item (regras do app + explicação da IA, que pesquisa o que não conhece).
import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { Verdict } from "@shared/types/common";
import type { CleanupEstimate } from "@shared/types/cleanup";
import type { DiscoverReport, FindingActionKind } from "@shared/types/discover";
import type { ScanResult } from "@shared/types/disk";
import type { AiItemExplanation, AiItemsReport } from "@shared/types/ai";
import { formatBytes, formatUsd } from "@shared/format";
import { api, errMsg, useEvent } from "../../lib/api";
import { useNav, type PageId } from "../../lib/nav";
import { AiSetupCallout } from "../ai";
import { useAiStatus } from "../ai/useAiStatus";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  ErrorBox,
  Tabs,
  useToast,
  type Tone,
} from "../ui";

type Del =
  | { kind: "cleanup"; targetId: string }
  | { kind: "discover"; findingId: string; action: FindingActionKind }
  | { kind: "file"; path: string };

interface Row {
  id: string;
  source: "Limpeza" | "Busca Profunda" | "Arquivo grande";
  title: string;
  detail: string;
  paths: string[];
  bytes: number;
  appVerdict: Verdict;
  admin?: boolean;
  /** null = não dá para apagar daqui (abre a página certa) */
  del: Del | null;
  page: PageId;
}

type Status = "apagar" | "manter" | "desconhecido";
type Filter = "all" | Status;

const STATUS: Record<
  Status,
  { label: string; tone: Tone; icon: typeof ShieldCheck }
> = {
  apagar: { label: "Pode apagar", tone: "ok", icon: ShieldCheck },
  manter: { label: "Melhor não apagar", tone: "danger", icon: ShieldAlert },
  desconhecido: {
    label: "Não sei o que é / revisar",
    tone: "warn",
    icon: ShieldQuestion,
  },
};

/** Id curto e estável (o mesmo item recebe o mesmo id entre análises, para reaproveitar a explicação da IA). */
function shortId(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++)
    h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return "i" + (h >>> 0).toString(36);
}

function statusOf(r: Row, ai?: AiItemExplanation): Status {
  if (r.appVerdict === "keep") return "manter";
  if (ai) return ai.verdict;
  return r.appVerdict === "safe" ? "apagar" : "desconhecido";
}

const SIMPLE_DELETE: FindingActionKind[] = ["recycle", "deleteLeftovers"];

function buildRows(
  est: CleanupEstimate | null,
  rep: DiscoverReport | null,
  scan: ScanResult | null,
): Row[] {
  const rows: Row[] = [];
  for (const t of est?.targets ?? []) {
    if (t.bytes < 1024 ** 2) continue;
    rows.push({
      id: shortId("cleanup:" + t.id),
      source: "Limpeza",
      title: t.title,
      detail: t.description,
      paths: t.paths,
      bytes: t.bytes,
      appVerdict: t.verdict,
      admin: t.requiresAdmin,
      del:
        t.manual || t.verdict === "keep"
          ? null
          : { kind: "cleanup", targetId: t.id },
      page: "cleanup",
    });
  }
  for (const f of rep?.findings ?? []) {
    if (f.bytes < 1024 ** 2) continue;
    const a = f.actions.find(
      (x) => SIMPLE_DELETE.includes(x.kind) && !x.dangerous,
    );
    rows.push({
      id: shortId("found:" + f.id),
      source: "Busca Profunda",
      title: f.title,
      detail: f.detail,
      paths: f.paths,
      bytes: f.bytes,
      appVerdict: f.verdict,
      admin: a?.requiresAdmin,
      del: a ? { kind: "discover", findingId: f.id, action: a.kind } : null,
      page: "discover",
    });
  }
  for (const d of scan?.drives ?? []) {
    for (const file of (d.oldLargeFiles ?? [])
      .filter((x) => x.bytes >= 500 * 1024 ** 2)
      .slice(0, 15)) {
      rows.push({
        id: shortId("file:" + file.path),
        source: "Arquivo grande",
        title: file.path.split("\\").pop() || file.path,
        detail: `Arquivo grande sem modificação há muito tempo (${new Date(file.lastWrite).toLocaleDateString("pt-BR")}).`,
        paths: [file.path],
        bytes: file.bytes,
        appVerdict: "review",
        del: { kind: "file", path: file.path },
        page: "disk",
      });
    }
  }
  return rows.sort((a, b) => b.bytes - a.bytes);
}

/** root: unidade aberta na página (ex.: 'E:\\') — a lista mostra só ela, com opção de ver todos os discos. */
export function EverythingView({
  onDeleted,
  root,
}: {
  onDeleted: () => void;
  root?: string;
}) {
  const [open, setOpen] = useState(false);
  const [allDrives, setAllDrives] = useState(false);
  const toast = useToast();
  const { go } = useNav();
  const { status: aiStatus } = useAiStatus();
  const [rows, setRows] = useState<Row[]>([]);
  const [ai, setAi] = useState<AiItemsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [limit, setLimit] = useState(60);

  async function load(): Promise<void> {
    const [est, rep, scan, exp] = await Promise.all([
      api.cleanup.getLastEstimate().catch(() => null),
      api.discover.getLastReport().catch(() => null),
      api.disk.getLastScan().catch(() => null),
      api.ai.getLastExplanations().catch(() => null),
    ]);
    let next = buildRows(est, rep, scan);
    // arquivos grandes dentro de áreas protegidas (programas, jogos, Windows) nem aparecem
    const files = next.filter((r) => r.del?.kind === "file");
    if (files.length) {
      const decisions = await api.cleanup
        .checkPaths(files.map((r) => r.paths[0]))
        .catch(() => []);
      const blocked = new Set(
        decisions
          .filter((d) => d.level === "blocked")
          .map((d) => d.path.toLowerCase()),
      );
      next = next.filter(
        (r) => r.del?.kind !== "file" || !blocked.has(r.paths[0].toLowerCase()),
      );
    }
    setRows(next);
    setAi(exp);
    setSelected(new Set());
  }

  useEffect(() => {
    load()
      .catch((e) => setError(errMsg(e)))
      .finally(() => setLoading(false));
  }, []);

  useEvent("ai:progress", (p) => {
    if (p.task === "ai:items" && p.message) setAiMsg(p.message);
  });

  const aiById = useMemo(
    () => new Map((ai?.items ?? []).map((x) => [x.id, x])),
    [ai],
  );
  const onlyDrive = root && !allDrives ? root.toUpperCase() : null;
  const driveLabel = onlyDrive ? onlyDrive.slice(0, 2) : null;
  const withStatus = rows
    .filter(
      (r) =>
        !onlyDrive ||
        r.paths.some((p) => p.toUpperCase().startsWith(onlyDrive)),
    )
    .map((r) => ({
      r,
      ai: aiById.get(r.id),
      st: statusOf(r, aiById.get(r.id)),
    }));
  const count = (s: Status): number =>
    withStatus.filter((x) => x.st === s).length;
  const sum = (s: Status): number =>
    withStatus.filter((x) => x.st === s).reduce((n, x) => n + x.r.bytes, 0);
  const visible = withStatus.filter((x) => filter === "all" || x.st === filter);
  const selRows = rows.filter((r) => selected.has(r.id));
  const selBytes = selRows.reduce((n, r) => n + r.bytes, 0);
  const canSelect = (x: (typeof withStatus)[number]): boolean =>
    Boolean(x.r.del) && x.st !== "manter";

  async function analyzeAll(): Promise<void> {
    setAnalyzing(true);
    setError(null);
    const res = await Promise.allSettled([
      api.cleanup.estimate({ extreme: true }),
      api.discover.scan({ deep: true }),
    ]);
    const failed = res
      .filter((x): x is PromiseRejectedResult => x.status === "rejected")
      .map((x) => errMsg(x.reason));
    if (failed.length) setError(failed.join(" · "));
    await load().catch((e) => setError(errMsg(e)));
    setAnalyzing(false);
  }

  async function explain(): Promise<void> {
    setAiBusy(true);
    setAiMsg("Preparando os itens...");
    try {
      const items = rows
        .slice(0, 300)
        .map((r) => ({
          id: r.id,
          title: r.title,
          paths: r.paths.slice(0, 3),
          bytes: r.bytes,
          source: r.source,
          appVerdict: r.appVerdict,
          detail: r.detail,
        }));
      const rep = await api.ai.explainItems(items);
      setAi(rep);
      toast.success(
        `A IA explicou ${rep.items.length} itens${rep.usedWebSearch ? " (pesquisou na internet o que não conhecia)" : ""}. ${rep.usage.costUnknown ? '' : `Custo: ${formatUsd(rep.usage.costUsd)}.`}`,
      );
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setAiBusy(false);
    }
  }

  async function deleteSelected(): Promise<void> {
    setDeleting(true);
    let freed = 0;
    let recycled = 0;
    let already = 0;
    const problems: string[] = [];
    try {
      const targetIds = selRows.flatMap((r) =>
        r.del?.kind === "cleanup" ? [r.del.targetId] : [],
      );
      if (targetIds.length)
        freed += (await api.cleanup.run({ targetIds })).totalFreed;
      for (const r of selRows) {
        if (r.del?.kind !== "discover") continue;
        const res = await api.discover.act({
          findingId: r.del.findingId,
          action: r.del.action,
        });
        if (res.cancelled) {
          problems.push(
            "Permissão de administrador negada: os itens restantes da Busca Profunda não foram apagados.",
          );
          break;
        }
        if (res.ok) {
          freed += res.bytesFreed ?? 0;
          recycled++;
        } else problems.push(`${r.title}: ${res.message}`);
      }
      const paths = selRows.flatMap((r) =>
        r.del?.kind === "file" ? [r.del.path] : [],
      );
      if (paths.length) {
        const rep = await api.cleanup.deleteFiles({
          paths,
          mode: "recycle",
          reason: "Tudo que dá para apagar",
        });
        freed += rep.bytesFreed;
        recycled += rep.deleted.length;
        const missing = rep.skipped
          .filter((s) => s.code === "missing")
          .map((s) => s.path);
        already = missing.length;
        problems.push(
          ...rep.skipped
            .filter((s) => s.code !== "missing")
            .map((s) => `${s.path}: ${s.reason}`),
        );
        // os arquivos grandes vêm da última análise do disco: sem isso, o que já foi apagado continua na lista
        const gone = [...rep.deleted, ...missing];
        if (gone.length)
          await api.disk.forgetFiles(gone).catch(() => undefined);
      }
      if (freed > 0 || recycled > 0) {
        toast.success(
          `Liberado: ${formatBytes(freed)}.${recycled ? " Arquivos e sobras foram para a Lixeira — esvazie-a para o espaço voltar." : ""}`,
        );
      }
      if (already)
        toast.info(
          `${already} arquivo(s) já tinham sido apagados antes (estão na Lixeira ou foram removidos) — saíram da lista.`,
        );
      if (problems.length)
        toast.error(
          `Alguns itens não saíram: ${problems.slice(0, 3).join(" · ")}${problems.length > 3 ? ` (+${problems.length - 3})` : ""}`,
        );
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setDeleting(false);
      setConfirm(false);
      await load().catch(() => undefined);
      onDeleted();
    }
  }

  const empty = !loading && rows.length === 0;
  return (
    <Card
      ai
      icon={Sparkles}
      title={`Tudo que dá para apagar${driveLabel ? ` — disco ${driveLabel}` : " — todos os discos"}`}
      subtitle="Limpeza (com a busca extrema), sobras de programas desinstalados, instaladores, zips já extraídos e arquivos grandes esquecidos. A IA explica item a item e pesquisa o que não conhece."
      actions={
        <>
          <Button
            variant="ghost"
            icon={open ? ChevronUp : ChevronDown}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Recolher" : "Abrir a lista"}
          </Button>
          {open && (
            <>
              <Button
                variant="primary"
                icon={Search}
                loading={analyzing}
                disabled={deleting}
                onClick={() => void analyzeAll()}
              >
                {analyzing
                  ? "Analisando o PC inteiro..."
                  : rows.length
                    ? "Analisar de novo"
                    : "Analisar tudo"}
              </Button>
              <Button
                variant="ai"
                icon={Sparkles}
                loading={aiBusy}
                disabled={!rows.length || !aiStatus?.configured || analyzing}
                onClick={() => void explain()}
              >
                {ai ? "IA: explicar de novo" : "IA: explicar cada item"}
              </Button>
            </>
          )}
        </>
      }
    >
      {!open ? (
        <p className="text-[13px] text-muted">
          {loading
            ? "Carregando..."
            : rows.length
              ? `${count("apagar")} itens (${formatBytes(sum("apagar"))}) podem ser apagados · ${count("desconhecido")} para revisar${driveLabel ? ` neste disco` : ""}. Abra a lista para ver item a item.`
              : 'Abra a lista e clique em "Analisar tudo" para o app achar tudo que dá para apagar no PC.'}
        </p>
      ) : (
        <div className="space-y-3">
          {!aiStatus?.configured && <AiSetupCallout compact />}
          {error && <ErrorBox error={error} />}
          {aiBusy && <p className="text-[13px] text-ai">{aiMsg}</p>}
          {analyzing && (
            <p className="text-[13px] text-muted">
              Medindo a limpeza (inclusive a extrema) e procurando sobras e
              instaladores em todos os discos. Leva cerca de 1 minuto; nada é
              apagado.
            </p>
          )}
          {empty && !analyzing && (
            <p className="text-[13px] text-muted">
              Clique em "Analisar tudo" para o app varrer o PC e listar aqui o
              que dá para apagar. Para incluir arquivos grandes esquecidos,
              analise também as unidades abaixo.
            </p>
          )}

          {rows.length > 0 && (
            <>
              <Tabs<Filter>
                value={filter}
                onChange={(f) => {
                  setFilter(f);
                  setLimit(60);
                }}
                tabs={[
                  {
                    id: "all",
                    label: `Tudo (${formatBytes(withStatus.reduce((n, x) => n + x.r.bytes, 0))})`,
                    badge: withStatus.length,
                  },
                  {
                    id: "apagar",
                    label: `Pode apagar (${formatBytes(sum("apagar"))})`,
                    badge: count("apagar"),
                  },
                  {
                    id: "desconhecido",
                    label: "Não sei / revisar",
                    badge: count("desconhecido"),
                  },
                  {
                    id: "manter",
                    label: "Melhor não apagar",
                    badge: count("manter"),
                  },
                ]}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setSelected(
                      new Set(
                        withStatus
                          .filter((x) => x.st === "apagar" && canSelect(x))
                          .map((x) => x.r.id),
                      ),
                    )
                  }
                >
                  Marcar tudo que pode apagar
                </Button>
                {root && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setAllDrives((v) => !v)}
                  >
                    {allDrives
                      ? `Só o disco ${root.slice(0, 2).toUpperCase()}`
                      : "Ver todos os discos"}
                  </Button>
                )}
                {selected.size > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelected(new Set())}
                  >
                    Desmarcar
                  </Button>
                )}
                {ai && (
                  <span className="text-[12px] text-faint">
                    Explicações da IA de{" "}
                    {new Date(ai.generatedAt).toLocaleString("pt-BR")}
                  </span>
                )}
                <div className="ml-auto">
                  <Button
                    variant="danger"
                    icon={Trash2}
                    disabled={!selected.size || deleting}
                    onClick={() => setConfirm(true)}
                  >
                    Apagar selecionados ({formatBytes(selBytes)})
                  </Button>
                </div>
              </div>
              <ul className="divide-y divide-border/60 rounded-lg border border-border">
                {visible.slice(0, limit).map(({ r, ai: x, st }) => {
                  const S = STATUS[st];
                  return (
                    <li
                      key={r.id}
                      className="flex items-start gap-3 px-3 py-2.5"
                    >
                      <div className="pt-0.5">
                        <Checkbox
                          checked={selected.has(r.id)}
                          disabled={!canSelect({ r, ai: x, st })}
                          onChange={(v) =>
                            setSelected((s) => {
                              const n = new Set(s);
                              if (v) n.add(r.id);
                              else n.delete(r.id);
                              return n;
                            })
                          }
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                          <Badge tone={S.tone} icon={S.icon}>
                            {S.label}
                          </Badge>
                          <span className="truncate">{r.title}</span>
                          <span className="text-[12px] font-normal text-faint">
                            {r.source}
                            {r.admin ? " · pede administrador" : ""}
                          </span>
                        </p>
                        <p className="mt-0.5 text-[12.5px] text-muted">
                          {x ? (
                            <>
                              <span className="text-ai">IA:</span>{" "}
                              <b className="font-medium text-text">
                                {x.whatIsIt}.
                              </b>{" "}
                              {x.explanation}
                            </>
                          ) : (
                            r.detail
                          )}
                        </p>
                        {r.paths[0] && (
                          <p
                            className="selectable mt-0.5 truncate font-mono text-[11px] text-faint"
                            title={r.paths.join("\n")}
                          >
                            {r.paths[0]}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="text-[13px] font-semibold tabular-nums">
                          {formatBytes(r.bytes)}
                        </span>
                        {!r.del && (
                          <button
                            className="flex items-center gap-1 text-[11.5px] text-accent hover:underline"
                            onClick={() => go(r.page)}
                          >
                            Abrir na página <ExternalLink className="size-3" />
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {visible.length > limit && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setLimit((n) => n + 60)}
                >
                  Mostrar mais ({visible.length - limit})
                </Button>
              )}
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirm}
        title={`Apagar ${selRows.length} item(ns) — ${formatBytes(selBytes)}?`}
        tone="danger"
        loading={deleting}
        confirmLabel="Apagar"
        message={
          <p>
            Caches e temporários da Limpeza são apagados de vez (os programas
            recriam o que precisarem). Sobras de programas, instaladores e
            arquivos grandes vão para a <b>Lixeira</b> — dá para recuperar até
            esvaziá-la. Itens marcados como "pede administrador" vão abrir o
            pedido de permissão do Windows.
          </p>
        }
        details={
          <ul className="space-y-1 text-[12.5px]">
            {selRows.slice(0, 40).map((r) => (
              <li key={r.id} className="flex justify-between gap-3">
                <span className="truncate">{r.title}</span>
                <span className="shrink-0 tabular-nums text-muted">
                  {formatBytes(r.bytes)}
                </span>
              </li>
            ))}
            {selRows.length > 40 && (
              <li className="text-faint">+ {selRows.length - 40} itens</li>
            )}
          </ul>
        }
        onConfirm={() => void deleteSelected()}
        onCancel={() => setConfirm(false)}
      />
    </Card>
  );
}
