import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { toast } from "@/stores/toastStore";
import type { Settings } from "@/types/api";

/**
 * Save-on-change settings writer. `update(s => ({ ...s, theme }))` patches
 * the cache optimistically, persists, and rolls back with a toast on failure.
 * Returns a no-op until settings have loaded.
 */
export function useUpdateSettings() {
  const qc = useQueryClient();
  const settings = useQuery(queries.settings);
  const mutation = useMutation({
    mutationFn: api.updateSettings,
    onMutate: async (next: Settings) => {
      await qc.cancelQueries({ queryKey: queries.settings.queryKey });
      const prev = qc.getQueryData<Settings>(queries.settings.queryKey);
      qc.setQueryData(queries.settings.queryKey, next);
      return { prev };
    },
    onError: (err, _next, ctx) => {
      if (ctx?.prev !== undefined) qc.setQueryData(queries.settings.queryKey, ctx.prev);
      toast.error("Couldn't save that setting", err instanceof Error ? err.message : String(err));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queries.settings.queryKey }),
  });

  const update = (patch: (s: Settings) => Settings) => {
    // Read the cache, not the render snapshot, so back-to-back toggles compose.
    const current = qc.getQueryData<Settings>(queries.settings.queryKey) ?? settings.data;
    if (!current) return;
    mutation.mutate(patch(current));
  };

  return { settings: settings.data, update, isSaving: mutation.isPending };
}
