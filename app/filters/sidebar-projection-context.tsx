import { createContext, useContext, type ReactNode } from "react";

const SidebarProjectionKeyContext = createContext("unfiltered");

export function SidebarProjectionKeyProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: string;
}) {
  return (
    <SidebarProjectionKeyContext.Provider value={value}>
      {children}
    </SidebarProjectionKeyContext.Provider>
  );
}

export function useSidebarProjectionKey(): string {
  return useContext(SidebarProjectionKeyContext);
}
