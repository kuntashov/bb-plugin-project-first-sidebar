export const UNREAD_FILTER_ID = Symbol("unread");
export const WAITING_FOR_ACTION_FILTER_ID = Symbol("waiting-for-action");

export type DynamicFilterId = typeof UNREAD_FILTER_ID | typeof WAITING_FOR_ACTION_FILTER_ID;

export const DYNAMIC_FILTERS = {
  [UNREAD_FILTER_ID]: {
    key: "unread",
    name: "Все непрочитанные",
    icon: "Mail",
    emptyMessage: "Нет непрочитанных тредов",
  },
  [WAITING_FOR_ACTION_FILTER_ID]: {
    key: "waiting-for-action",
    name: "Ждут действия",
    icon: "MessageQuestion",
    emptyMessage: "Нет тредов, ожидающих действия",
  },
} as const;

export function isDynamicFilterId(id: unknown): id is DynamicFilterId {
  return id === UNREAD_FILTER_ID || id === WAITING_FOR_ACTION_FILTER_ID;
}
