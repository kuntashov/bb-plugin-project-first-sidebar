import type {
  PluginRpcCallArgs,
  PluginRpcClient,
} from "@get-bb/plugin-sdk/app";
import type { projectFirstSidebarRpcContract } from "../../server.js";
import type { FilterMutationResult } from "../../shared/filters.js";
import type { WindowFilterStore } from "./filter-store.js";

type FilterRpcContract = typeof projectFirstSidebarRpcContract;
type MutationInput<Method extends keyof FilterRpcContract> =
  PluginRpcCallArgs<FilterRpcContract[Method]>[0];

export function createFilterEditorService(
  rpc: PluginRpcClient<FilterRpcContract>,
  store: Pick<WindowFilterStore, "invalidate">,
) {
  async function settle(
    pending: Promise<FilterMutationResult>,
  ): Promise<FilterMutationResult> {
    const result = await pending;
    if (result.status === "success" || result.status === "conflict") {
      store.invalidate();
    }
    return result;
  }

  return {
    read() {
      return rpc.call("listFilters", null);
    },
    create(input: MutationInput<"createFilter">) {
      return settle(rpc.call("createFilter", input));
    },
    update(input: MutationInput<"updateFilter">) {
      return settle(rpc.call("updateFilter", input));
    },
    delete(input: MutationInput<"deleteFilter">) {
      return settle(rpc.call("deleteFilter", input));
    },
    reorder(input: MutationInput<"reorderFilters">) {
      return settle(rpc.call("reorderFilters", input));
    },
    setDisplayMode(input: MutationInput<"setDisplayMode">) {
      return settle(rpc.call("setDisplayMode", input));
    },
    setPinnedMode(input: MutationInput<"setPinnedMode">) {
      return settle(rpc.call("setPinnedMode", input));
    },
  };
}
