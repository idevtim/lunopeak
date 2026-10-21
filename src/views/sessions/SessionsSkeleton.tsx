import { Page } from "@/components/ui/Page";
import { Bone, PageLoading } from "@/components/ui/PageStates";

export function SessionsSkeleton() {
  return (
    <Page>
      <div className="flex flex-col gap-2">
        <Bone className="h-7 w-32 rounded-lg" />
        <Bone className="h-4 w-96 rounded-md" />
      </div>
      <PageLoading caption="Reading your session history…">
        <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-4">
          <div className="flex flex-col gap-2">
            <Bone className="h-10" />
            {Array.from({ length: 8 }).map((_, i) => (
              <Bone key={i} className="h-12 rounded-[10px]" />
            ))}
          </div>
          <div className="flex flex-col gap-3">
            <Bone className="h-36" />
            <Bone className="h-44" />
            <Bone className="h-36" />
            <Bone className="h-24" />
          </div>
        </div>
      </PageLoading>
    </Page>
  );
}
