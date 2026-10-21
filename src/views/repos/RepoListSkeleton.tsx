import { Page } from "@/components/ui/Page";
import { Bone, PageLoading } from "@/components/ui/PageStates";

export function RepoListSkeleton() {
  return (
    <Page>
      <div className="flex flex-col gap-2">
        <Bone className="h-7 w-28 rounded-lg" />
        <Bone className="h-4 w-[460px] rounded-md" />
      </div>
      <PageLoading caption="Checking each repo for changes…">
        <div className="flex items-center gap-2.5">
          <Bone className="h-8 flex-1 rounded-lg" />
          {["w-[52px]", "w-[116px]", "w-[104px]", "w-[120px]"].map((w) => (
            <Bone key={w} className={`h-8 rounded-full ${w}`} />
          ))}
        </div>
        <div className="flex flex-col gap-px overflow-hidden rounded-[14px]">
          <Bone className="h-9 rounded-none" />
          {Array.from({ length: 8 }).map((_, i) => (
            <Bone key={i} className="h-[52px] rounded-none opacity-80" />
          ))}
        </div>
      </PageLoading>
    </Page>
  );
}
