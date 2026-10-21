import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/utils";
import type { FileDiff } from "@/types/api";

/**
 * Collapsible list of changed files. One file is open at a time, showing
 * its unified diff as numbered green / rose rows.
 */
export function FileDiffList({
  files,
  initiallyOpen,
  className,
}: {
  files: FileDiff[];
  /** Path to open first. Defaults to the first file. */
  initiallyOpen?: string | null;
  className?: string;
}) {
  const [open, setOpen] = useState<string | null>(
    initiallyOpen === undefined ? (files[0]?.path ?? null) : initiallyOpen,
  );
  return (
    <div className={cn("flex flex-col", className)}>
      {files.map((f, i) => {
        const isOpen = open === f.path;
        return (
          <div key={f.path}>
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : f.path)}
              aria-expanded={isOpen}
              className={cn(
                "flex w-full items-center gap-2.5 px-4 py-[9px] text-left transition-colors",
                i > 0 && "border-t border-black/[0.04] dark:border-white/[0.05]",
                isOpen
                  ? "bg-black/[0.02] dark:bg-white/[0.03]"
                  : "hover:bg-black/[0.02] dark:hover:bg-white/[0.03]",
              )}
            >
              <ChevronRight
                size={12}
                strokeWidth={2.25}
                className={cn(
                  "shrink-0 text-zinc-500 transition-transform dark:text-zinc-400",
                  isOpen && "rotate-90",
                )}
              />
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-zinc-900 dark:text-zinc-100">
                {f.path}
              </span>
              {f.isNew && <Pill tone="green">New file</Pill>}
              {f.isDeleted && <Pill tone="rose">Deleted</Pill>}
              {f.binary ? (
                <Pill>Binary</Pill>
              ) : (
                <LineCounts insertions={f.insertions} deletions={f.deletions} />
              )}
            </button>
            {isOpen && <DiffBody file={f} />}
          </div>
        );
      })}
    </div>
  );
}

export function LineCounts({
  insertions,
  deletions,
  className,
}: {
  insertions: number;
  deletions: number;
  className?: string;
}) {
  return (
    <span className={cn("flex shrink-0 gap-2 text-xs font-semibold tabular-nums", className)}>
      <span className="text-emerald-700 dark:text-emerald-400">+{insertions.toLocaleString()}</span>
      <span className="text-rose-700 dark:text-rose-400">−{deletions.toLocaleString()}</span>
    </span>
  );
}

interface DiffRow {
  kind: "add" | "del" | "ctx" | "gap";
  no: number | null;
  text: string;
}

/** Unified diff body → display rows. Added and context lines carry the new line number, removed lines the old one. */
function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)/);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      if (rows.length > 0) rows.push({ kind: "gap", no: null, text: "" });
      continue;
    }
    if (line.startsWith("\\") || line === "") continue;
    const body = line.slice(1);
    if (line[0] === "+") rows.push({ kind: "add", no: newNo++, text: body });
    else if (line[0] === "-") rows.push({ kind: "del", no: oldNo++, text: body });
    else {
      rows.push({ kind: "ctx", no: newNo, text: body });
      oldNo++;
      newNo++;
    }
  }
  return rows;
}

function DiffBody({ file }: { file: FileDiff }) {
  const rows = useMemo(() => parsePatch(file.patch), [file.patch]);
  if (file.binary || rows.length === 0) {
    return (
      <div className="border-y border-black/[0.05] bg-[#fcfcfc] px-4 py-3 text-[12.5px] text-zinc-500 dark:border-white/[0.06] dark:bg-white/[0.02] dark:text-zinc-400">
        {file.binary
          ? "Binary file — nothing to show here."
          : file.truncated
            ? "This file is too large to show here."
            : "No line changes (only the file mode changed)."}
      </div>
    );
  }
  return (
    <div className="overflow-x-auto border-y border-black/[0.05] bg-[#fcfcfc] py-1.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
      <div className="min-w-max font-mono text-xs leading-5">
        {rows.map((r, i) =>
          r.kind === "gap" ? (
            <div key={i} className="grid grid-cols-[36px_14px_minmax(0,1fr)] text-zinc-400">
              <span className="pr-2 text-right">⋯</span>
            </div>
          ) : (
            <div
              key={i}
              className={cn(
                "grid grid-cols-[36px_14px_minmax(0,1fr)]",
                r.kind === "add" && "bg-emerald-500/[0.09]",
                r.kind === "del" && "bg-rose-500/[0.08]",
              )}
            >
              <span className="select-none pr-2 text-right text-zinc-400">{r.no}</span>
              <span
                className={cn(
                  "select-none",
                  r.kind === "add" && "text-emerald-700 dark:text-emerald-400",
                  r.kind === "del" && "text-rose-700 dark:text-rose-400",
                )}
              >
                {r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}
              </span>
              <span className="whitespace-pre pr-4 text-zinc-800 dark:text-zinc-200">{r.text}</span>
            </div>
          ),
        )}
      </div>
      {file.truncated && (
        <p className="m-0 px-4 pt-2 text-xs text-zinc-500 dark:text-zinc-400">
          Long diff — open the file in your editor to see the rest.
        </p>
      )}
    </div>
  );
}
