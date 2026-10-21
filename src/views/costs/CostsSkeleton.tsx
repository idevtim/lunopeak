import { Page, PageHeader } from "@/components/ui/Page";
import { Bone, PageLoading } from "@/components/ui/PageStates";

/** Costs page skeleton: budget bar, three stat cards, daily chart, two breakdowns. */
export function CostsSkeleton() {
  return (
    <Page>
      <PageHeader title="Costs" />
      <PageLoading caption="Adding up what your agents spent…">
        <Bone className="h-[88px]" />
        <div className="grid grid-cols-3 gap-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Bone key={i} className="h-[98px]" />
          ))}
        </div>
        <Bone className="h-[240px]" />
        <div className="grid grid-cols-2 gap-3">
          <Bone className="h-[190px]" />
          <Bone className="h-[190px]" />
        </div>
      </PageLoading>
    </Page>
  );
}
