import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { queries } from "@/lib/queries";
import { plural } from "@/lib/format";
import { useDelayedLoading } from "@/hooks/useDelayedLoading";
import { Page, PageHeader, Card, Mono } from "@/components/ui/Page";
import { EmptyState, ErrorState, PageLoading, Bone } from "@/components/ui/PageStates";
import { Pill } from "@/components/ui/Pill";
import { Button } from "@/components/ui/Button";
import { toast } from "@/stores/toastStore";
import type { EnvFile } from "@/types/api";

/** Variable names shown before "+ n more". */
const PREVIEW_KEYS = 4;

export function EnvView() {
  const filesQuery = useQuery(queries.envFiles);
  const showSkeleton = useDelayedLoading(filesQuery.isLoading);
  if (filesQuery.isLoading) return showSkeleton ? <EnvSkeleton /> : null;

  const files = filesQuery.data ?? [];
  const atRisk = files.filter((f) => f.committedRisk);
  const repoCount = new Set(files.map((f) => f.repoPath || f.repoName)).size;
  // Risky files first, then by repo.
  const sorted = [...files].sort(
    (a, b) =>
      Number(b.committedRisk) - Number(a.committedRisk) ||
      a.repoName.localeCompare(b.repoName) ||
      a.fileName.localeCompare(b.fileName),
  );

  return (
    <Page>
      <PageHeader
        title="Environment"
        lead={
          filesQuery.isError ? undefined : files.length === 0 ? (
            "Checks that your .env files aren't committed by mistake."
          ) : (
            <>
              <b>{plural(files.length, ".env file")}</b> across {plural(repoCount, "repo")}.{" "}
              {atRisk.length === 0
                ? "All of them are ignored by git."
                : `${atRisk.length} ${atRisk.length === 1 ? "isn't" : "aren't"} ignored by git, so ${
                    atRisk.length === 1 ? "its" : "their"
                  } secrets could be committed.`}
            </>
          )
        }
      />

      {filesQuery.isError ? (
        <ErrorState
          title="Couldn't look for .env files"
          body="LunoPeak couldn't finish scanning your repos. This is usually temporary."
          onRetry={() => void filesQuery.refetch()}
          error={filesQuery.error}
        />
      ) : files.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No .env files found"
          body="If your projects use .env files, LunoPeak checks they aren't committed by mistake."
        />
      ) : (
        <>
          {atRisk.map((f) => (
            <RiskBanner key={`${f.repoPath}-${f.fileName}`} file={f} />
          ))}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {sorted.map((f) => (
              <EnvCard key={`${f.repoPath}-${f.fileName}`} file={f} />
            ))}
          </div>
        </>
      )}
    </Page>
  );
}

/**
 * There's no command to edit .gitignore, so the banner copies the line to add
 * instead of adding it.
 */
function RiskBanner({ file }: { file: EnvFile }) {
  const keys =
    file.keys.length > 2
      ? `${file.keys.slice(0, 2).join(", ")} and ${file.keys.length - 2} more`
      : file.keys.join(" and ");
  return (
    <div className="flex items-center gap-3 rounded-[14px] border border-rose-500/25 bg-rose-500/[0.05] px-[18px] py-3">
      <span className="size-[7px] shrink-0 rounded-full bg-rose-600" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13.5px] font-medium text-zinc-900 dark:text-zinc-100">
          {file.repoName}/{file.fileName} isn't in .gitignore
        </span>
        <span className="text-[12.5px] text-zinc-600 dark:text-zinc-400">
          {keys ? `It holds ${keys}. ` : ""}
          Add it to .gitignore before your next commit.
        </span>
      </div>
      <Button
        variant="primary"
        onClick={() => {
          navigator.clipboard
            ?.writeText(file.fileName)
            .then(() =>
              toast.success(
                `Copied “${file.fileName}”`,
                `Paste it as a new line in ${file.repoName}/.gitignore.`,
              ),
            )
            .catch((e) => toast.error("Couldn't copy", e instanceof Error ? e.message : String(e)));
        }}
      >
        Copy .gitignore line
      </Button>
    </div>
  );
}

function EnvCard({ file }: { file: EnvFile }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? file.keys : file.keys.slice(0, PREVIEW_KEYS);
  const hidden = file.keys.length - shown.length;
  return (
    <Card className="flex flex-col gap-3 px-[18px] pb-4 pt-3.5">
      <div className="flex items-center gap-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <Mono className="truncate text-[13px] font-semibold text-zinc-900 dark:text-zinc-100">
            {file.fileName}
          </Mono>
          <span className="truncate text-xs text-zinc-500 dark:text-zinc-400">
            {file.repoName} · {plural(file.keys.length, "variable")}
            {!file.repoHasExample && " · no .env.example"}
          </span>
        </div>
        {file.committedRisk ? (
          <Pill tone="rose">Not ignored</Pill>
        ) : (
          <Pill tone="green">Ignored by git</Pill>
        )}
      </div>
      {file.keys.length > 0 && (
        <div className="flex flex-col gap-1">
          {shown.map((k) => (
            <div key={k} className="flex items-center gap-2.5 font-mono text-xs">
              <span className="min-w-0 flex-1 truncate text-zinc-700 dark:text-zinc-300">{k}</span>
              <span className="tracking-[1px] text-zinc-400 dark:text-zinc-500" aria-label="hidden value">
                ••••••••
              </span>
            </div>
          ))}
          {(hidden > 0 || expanded) && file.keys.length > PREVIEW_KEYS && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="self-start font-mono text-xs text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              {expanded ? "Show less" : `+ ${hidden} more`}
            </button>
          )}
        </div>
      )}
    </Card>
  );
}

function EnvSkeleton() {
  return (
    <Page>
      <PageLoading caption="Finding your .env files…">
        <Bone className="h-7 w-36 rounded-md" />
        <Bone className="h-4 w-96 rounded-md" />
        <Bone className="h-16" />
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Bone key={i} className="h-36" />
          ))}
        </div>
      </PageLoading>
    </Page>
  );
}
