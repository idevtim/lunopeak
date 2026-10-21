import { Bone, PageLoading } from "@/components/ui/PageStates";
import { Page } from "@/components/ui/Page";

/** Home's layout in gray blocks: header, attention line, stats, two cards, activity, three lists. */
export function DashboardSkeleton() {
  return (
    <Page>
      <div className="flex flex-col gap-2">
        <Bone className="h-7 w-64 rounded-md" />
        <Bone className="h-4 w-56 rounded-md" />
      </div>
      <PageLoading caption="Checking your agents, limits and spending…">
        <div className="flex flex-col gap-5">
          <Bone className="h-[46px]" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Bone key={i} className="h-[98px]" />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Bone className="h-[250px]" />
            <Bone className="h-[250px]" />
          </div>
          <Bone className="h-[230px]" />
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Bone key={i} className="h-[180px]" />
            ))}
          </div>
        </div>
      </PageLoading>
    </Page>
  );
}
