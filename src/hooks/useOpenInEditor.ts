import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/tauri";
import { queries } from "@/lib/queries";
import { editorLabel } from "@/lib/editors";
import { useEditorPickerStore } from "@/stores/editorPickerStore";
import { toast } from "@/stores/toastStore";

/**
 * Launches `path` in the user's preferred editor. When no default is set,
 * pops the global EditorPicker dialog so the user can pick one (and
 * optionally remember the choice).
 */
export function useOpenInEditor() {
  const settings = useQuery(queries.settings);
  const openPicker = useEditorPickerStore((s) => s.open);

  const open = useCallback(
    (path: string) => {
      const def = settings.data?.editor?.defaultEditor ?? null;
      if (!def) {
        openPicker(path);
        return;
      }
      api.openPathInEditor(path, def).catch((e) => {
        toast.error(
          `Couldn't open in ${editorLabel(def)}`,
          e instanceof Error ? e.message : String(e),
        );
      });
    },
    [settings.data, openPicker],
  );

  return open;
}
