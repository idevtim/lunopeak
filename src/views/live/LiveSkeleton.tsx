import { Bone, PageLoading } from "@/components/ui/PageStates";
import { Page } from "@/components/ui/Page";

export function LiveSkeleton() {
  return (
    <Page className="gap-[18px]">
      <div className="flex flex-col gap-2">
        <h1 className="m-0 text-2xl font-semibold tracking-[-0.015em] text-zinc-900 dark:text-zinc-50">
          Live
        </h1>
        <Bone className="h-4 w-72 rounded-md" />
      </div>
      <PageLoading caption="Looking for running agents…">
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex flex-col gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Bone key={i} className="h-[178px]" />
            ))}
          </div>
          <Bone className="h-[360px]" />
        </div>
      </PageLoading>
    </Page>
  );
}
