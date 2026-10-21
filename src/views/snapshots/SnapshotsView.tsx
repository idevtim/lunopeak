import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ChevronRight, Clock, Info, Trash2 } from "lucide-react";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { useHashRoute } from "@/hooks/useHashRoute";
import { Card, Mono, Page, PageHeader } from "@/components/ui/Page";
import { Bone, EmptyState, ErrorState, PageLoading } from "@/components/ui/PageStates";
import { Button } from "@/components/ui/Button";
import { toast } from "@/stores/toastStore";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RepoOverviewEntry, Snapshot, SnapshotRepo } from "@/types/api";

const GLOW_MS = 1400;
// Deletes wait out the Undo toast (5s) before they hit disk.
const DELETE_DELAY_MS = 5500;
const pendingDeletes = new Map<string, ReturnType<typeof setTimeout>>();

function deleteWithUndo(qc: QueryClient, snap: Snapshot) {
  const refresh = () => qc.invalidateQueries({ queryKey: queries.snapshots.queryKey });
  pendingDeletes.set(
    snap.id,
    setTimeout(() => {
      api
        .deleteSnapshot(snap.id)
        .catch((e) =>
          toast.error("Couldn't delete snapshot", e instanceof Error ? e.message : String(e)),
        )
        .finally(() => {
          pendingDeletes.delete(snap.id);
          void refresh();
        });
    }, DELETE_DELAY_MS),
  );
  qc.setQueryData<Snapshot[]>(queries.snapshots.queryKey, (old) =>
    old?.filter((s) => s.id !== snap.id),
  );
  toast.success("Snapshot deleted", `“${snap.name}”`, {
    action: {
      label: "Undo",
      onClick: () => {
        clearTimeout(pendingDeletes.get(snap.id));
        pendingDeletes.delete(snap.id);
        void refresh();
      },
    },
  });
}

const isDirty = (r: RepoOverviewEntry) => r.hasUncommitted || r.uncommittedFiles > 0;

function savedState(r: SnapshotRepo) {
  return r.dirty
    ? { label: r.diffFiles.length ? `${plural(r.diffFiles.length, "file")} changed` : "Changes saved", tone: "text-blue-700 dark:text-blue-400" }
    : { label: "Clean", tone: "text-emerald-700 dark:text-emerald-400" };
}

function formatWhen(ts: number) {
  const d = new Date(ts);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date().toDateString()) return `Today, ${time}`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

export function SnapshotsView() {
  const qc = useQueryClient();
  const { params } = useHashRoute();
  const overview = useQuery(queries.reposOverview);
  const snapshots = useQuery(queries.snapshots);
  const nameRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [glowId, setGlowId] = useState<string | null>(null);

  const take = useMutation({
    mutationFn: () => api.takeSnapshot(name.trim(), note.trim() || undefined),
    onSuccess: (snap) => {
      void qc.invalidateQueries({ queryKey: queries.snapshots.queryKey });
      setName("");
      setNote("");
      setGlowId(snap.id);
      const dirty = snap.repos.filter((r) => r.dirty).length;
      toast.success(
        "Snapshot saved",
        dirty > 0
          ? `All ${plural(snap.repos.length, "repo")}, including uncommitted changes in ${dirty}.`
          : `All ${plural(snap.repos.length, "repo")}.`,
      );
    },
    onError: (e) =>
      toast.error("Couldn't take snapshot", e instanceof Error ? e.message : String(e)),
  });

  useEffect(() => {
    if (!glowId) return;
    const t = setTimeout(() => setGlowId(null), GLOW_MS);
    return () => clearTimeout(t);
  }, [glowId]);

  // ⌘K "Take a snapshot" lands here with ?take=1.
  const wantsTake = params.get("take") === "1";
  const loaded = !snapshots.isLoading;
  useEffect(() => {
    if (wantsTake && loaded) nameRef.current?.focus();
  }, [wantsTake, loaded]);

  const showSkeleton = useDelayedLoading(snapshots.isLoading);
  if (snapshots.isLoading) return showSkeleton ? <SnapshotsSkeleton /> : null;

  const repos = [...(overview.data?.repos ?? [])].sort(
    (a, b) => Number(isDirty(b)) - Number(isDirty(a)) || a.name.localeCompare(b.name),
  );
  const dirtyCount = repos.filter(isDirty).length;
  const list = (snapshots.data ?? []).filter((s) => !pendingDeletes.has(s.id));
  const canTake = name.trim().length > 0 && !take.isPending;
  const submit = () => canTake && take.mutate();
  const inputClass =
    "min-w-0 rounded-lg border border-black/[0.12] bg-white px-2.5 py-[7px] text-[13px] text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-blue-500/60 focus:ring-[3px] focus:ring-blue-500/12 dark:border-white/[0.12] dark:bg-white/[0.04] dark:text-zinc-100";

  return (
    <Page>
      <PageHeader
        title="Snapshots"
        lead="A snapshot saves where every repo is right now: its branch, latest commit and any uncommitted changes. Take one before a big change so you can get back."
      />

      <Card className="flex flex-col gap-3 px-[18px] py-4">
        <h3 className="m-0 text-sm font-semibold text-zinc-900 dark:text-zinc-100">Take a snapshot</h3>
        <div className="flex items-center gap-2">
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Name, e.g. Before the auth rewrite"
            className={cn(inputClass, "flex-[1.2]")}
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Note (optional)"
            className={cn(inputClass, "flex-1")}
          />
          <Button variant="primary" size="md" disabled={!canTake} onClick={submit}>
            {take.isPending ? "Saving…" : "Take snapshot"}
          </Button>
        </div>
        {overview.data && (
          <div className="flex items-center gap-2 text-[12.5px] text-zinc-600 dark:text-zinc-400">
            <Info size={13} strokeWidth={2} className="shrink-0 text-zinc-500" />
            <span className="flex-1">
              {repos.length === 0
                ? "No repos found yet. Add project folders in Settings."
                : `Saves all ${plural(repos.length, "repo")}.${
                    dirtyCount > 0
                      ? ` ${dirtyCount} ${dirtyCount === 1 ? "has" : "have"} uncommitted changes, which will be saved too.`
                      : ""
                  }`}
            </span>
            {repos.length > 0 && (
              <Button variant="link" onClick={() => setPreviewOpen((o) => !o)}>
                {previewOpen ? "Hide" : "See what’s saved"}
              </Button>
            )}
          </div>
        )}
        {previewOpen && repos.length > 0 && <SavePreview repos={repos} />}
      </Card>

      {snapshots.error ? (
        <ErrorState
          title="Couldn't load your snapshots"
          body="LunoPeak keeps snapshots in its app data folder. It couldn't read them just now."
          onRetry={() => void snapshots.refetch()}
          error={snapshots.error}
        />
      ) : list.length === 0 ? (
        <EmptyState
          icon={Clock}
          title="No snapshots yet"
          body="Take one before a big change so you can get every repo back to where it is now."
          primary={{ label: "Take a snapshot", onClick: () => nameRef.current?.focus() }}
        />
      ) : (
        <section className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2 px-0.5">
            <span className="flex-1 text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">
              Saved snapshots
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {plural(list.length, "snapshot")}
            </span>
          </div>
          {list.map((snap) => (
            <SnapshotCard
              key={snap.id}
              snap={snap}
              current={overview.data?.repos ?? null}
              open={openId === snap.id}
              glow={glowId === snap.id}
              onToggle={() => setOpenId((id) => (id === snap.id ? null : snap.id))}
              onDelete={() => deleteWithUndo(qc, snap)}
            />
          ))}
        </section>
      )}
    </Page>
  );
}

const ROW = "grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_80px_140px] items-center gap-3 py-[7px] text-[12.5px]";
const ROW_DIVIDER = "border-t border-black/[0.05] dark:border-white/[0.06]";

/** What a snapshot taken now would save: dirty repos first, the clean tail summarized. */
function SavePreview({ repos }: { repos: RepoOverviewEntry[] }) {
  const shown = repos.slice(0, Math.max(5, repos.filter(isDirty).length));
  const rest = repos.slice(shown.length);
  return (
    <div className="rounded-[10px] bg-black/[0.025] px-3 py-1 dark:bg-white/[0.04]">
      {shown.map((r, i) => (
        <div key={r.id} className={cn(ROW, "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_140px]", i > 0 && ROW_DIVIDER)}>
          <Mono className="truncate text-[12.5px] text-zinc-900 dark:text-zinc-100">{r.name}</Mono>
          <Mono className="truncate text-[12.5px] text-zinc-600 dark:text-zinc-400">{r.branch ?? "—"}</Mono>
          <span
            className={cn(
              "text-right",
              isDirty(r) ? "text-blue-700 dark:text-blue-400" : "text-emerald-700 dark:text-emerald-400",
            )}
          >
            {isDirty(r)
              ? r.uncommittedFiles > 0
                ? `${plural(r.uncommittedFiles, "file")} changed`
                : "Has changes"
              : "Clean"}
          </span>
        </div>
      ))}
      {rest.length > 0 && (
        <div className={cn(ROW_DIVIDER, "py-[7px] text-xs text-zinc-500 dark:text-zinc-400")}>
          + {rest.length} more, all clean
        </div>
      )}
    </div>
  );
}

function SnapshotCard({
  snap,
  current,
  open,
  glow,
  onToggle,
  onDelete,
}: {
  snap: Snapshot;
  current: RepoOverviewEntry[] | null;
  open: boolean;
  glow: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [comparing, setComparing] = useState(false);
  const dirty = snap.repos.filter((r) => r.dirty).length;
  const meta = [
    formatWhen(snap.createdTs),
    plural(snap.repos.length, "repo"),
    dirty > 0 && `${dirty} with changes`,
  ]
    .filter(Boolean)
    .join(" · ");

  const compare = () => {
    setComparing((c) => !(c && open));
    if (!open) onToggle();
  };

  return (
    <Card
      className="flex flex-col transition-shadow duration-[600ms]"
      style={{ boxShadow: glow ? "0 0 0 3px rgba(59,130,246,0.25)" : "none" }}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          onClick={onToggle}
          aria-label={open ? "Hide details" : "Show details"}
          aria-expanded={open}
          className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-black/[0.05] dark:hover:bg-white/[0.06]"
        >
          <ChevronRight
            size={13}
            strokeWidth={2.25}
            className={cn("text-zinc-500 transition-transform duration-150", open && "rotate-90")}
          />
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13.5px] font-semibold text-zinc-900 dark:text-zinc-100">
            {snap.name}
          </span>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{meta}</span>
        </div>
        {confirming ? (
          <span className="flex items-center gap-1.5">
            <span className="text-[12.5px] text-zinc-700 dark:text-zinc-300">Delete this snapshot?</span>
            <Button onClick={() => setConfirming(false)}>Cancel</Button>
            <Button variant="destructive" onClick={onDelete}>
              Delete
            </Button>
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            {current && (
              <Button onClick={compare}>{comparing && open ? "Hide comparison" : "Compare with now"}</Button>
            )}
            <button
              type="button"
              onClick={() => setConfirming(true)}
              title="Delete"
              aria-label="Delete snapshot"
              className="flex size-[30px] items-center justify-center rounded-[7px] text-zinc-400 hover:bg-rose-500/[0.08] hover:text-rose-600"
            >
              <Trash2 size={14} strokeWidth={1.9} />
            </button>
          </span>
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-2 pb-3.5 pl-[52px] pr-4">
          {snap.note && (
            <span className="text-[13px] italic text-zinc-700 dark:text-zinc-300">“{snap.note}”</span>
          )}
          {comparing && current ? (
            <CompareRows snap={snap} current={current} />
          ) : (
            <div className="rounded-[10px] bg-black/[0.025] px-3 py-1 dark:bg-white/[0.04]">
              {snap.repos.map((r, i) => {
                const st = savedState(r);
                return (
                  <div key={r.repoPath} className={cn(ROW, i > 0 && ROW_DIVIDER)}>
                    <Mono className="truncate text-[12.5px] text-zinc-900 dark:text-zinc-100">{r.repoName}</Mono>
                    <Mono className="truncate text-[12.5px] text-zinc-600 dark:text-zinc-400">{r.branch ?? "—"}</Mono>
                    <Mono className="text-[12.5px] text-zinc-500">{r.head?.slice(0, 7) ?? "—"}</Mono>
                    <span className={cn("text-right", st.tone)}>{st.label}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** Saved branch vs. the branch and working tree each repo has right now. */
function CompareRows({ snap, current }: { snap: Snapshot; current: RepoOverviewEntry[] }) {
  const byPath = new Map(current.map((r) => [r.path, r]));
  const rows = snap.repos.map((r) => {
    const now = byPath.get(r.repoPath);
    if (!now) return { r, now: null, label: "Not found now", tone: "text-zinc-500" };
    if (now.branch !== r.branch)
      return { r, now, label: "Different branch", tone: "text-amber-700 dark:text-amber-400" };
    if (isDirty(now))
      return {
        r,
        now,
        label: now.uncommittedFiles > 0 ? `${plural(now.uncommittedFiles, "file")} changed now` : "Has changes now",
        tone: "text-blue-700 dark:text-blue-400",
      };
    return { r, now, label: "Same branch, clean", tone: "text-emerald-700 dark:text-emerald-400" };
  });
  const moved = rows.filter((x) => x.now && x.now.branch !== x.r.branch).length;

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12.5px] text-zinc-600 dark:text-zinc-400">
        {moved === 0
          ? "Every repo is still on the branch it was on when you took this snapshot."
          : `${plural(moved, "repo")} ${moved === 1 ? "is" : "are"} on a different branch now.`}
      </span>
      <div className="rounded-[10px] bg-black/[0.025] px-3 py-1 dark:bg-white/[0.04]">
        <div className={cn(ROW, "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_150px] text-xs text-zinc-500")}>
          <span>Repo</span>
          <span>Saved</span>
          <span>Now</span>
          <span />
        </div>
        {rows.map(({ r, now, label, tone }) => (
          <div
            key={r.repoPath}
            className={cn(ROW, ROW_DIVIDER, "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_150px]")}
          >
            <Mono className="truncate text-[12.5px] text-zinc-900 dark:text-zinc-100">{r.repoName}</Mono>
            <Mono className="truncate text-[12.5px] text-zinc-600 dark:text-zinc-400">{r.branch ?? "—"}</Mono>
            <Mono className="truncate text-[12.5px] text-zinc-600 dark:text-zinc-400">{now?.branch ?? "—"}</Mono>
            <span className={cn("text-right", tone)}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SnapshotsSkeleton() {
  return (
    <Page>
      <PageHeader title="Snapshots" />
      <PageLoading caption="Loading your snapshots…">
        <Bone className="h-[124px]" />
        <Bone className="h-4 w-40 rounded-md" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Bone key={i} className="h-[62px]" />
        ))}
      </PageLoading>
    </Page>
  );
}
