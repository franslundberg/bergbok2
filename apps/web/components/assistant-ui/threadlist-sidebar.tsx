import type * as React from "react";
import Image from "next/image";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { AuthPanel, type AuthAction } from "@/components/auth-panel";
import type { PublicAuthState } from "@/lib/bergbok/auth-types";

const statusLabel: Record<string, string> = {
  locked: "Låst",
  working: "Pågår",
  running: "Bokför",
  preliminary: "Förslag",
  approved: "Godkänd",
};

export function ThreadListSidebar({
  authState,
  authBusy,
  authError,
  onAuthAction,
  summary,
  selectedPeriodId,
  onSelectPeriod,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  authState: PublicAuthState;
  authBusy: boolean;
  authError?: string;
  onAuthAction: (action: AuthAction) => Promise<void>;
  summary?: { periods: Array<{ id: string; status: string; uploadCount: number }> };
  selectedPeriodId?: string;
  onSelectPeriod: (periodId: string) => void;
}) {
  const { state, setOpen, isMobile, openMobile, setOpenMobile } = useSidebar();

  return (
    <>
      <aside className="flex h-dvh w-12 shrink-0 flex-col items-center border-r bg-sidebar px-2 py-2 text-sidebar-foreground md:hidden">
        <button
          type="button"
          onClick={() => setOpenMobile(true)}
          className="flex size-8 items-center justify-center rounded-md hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
          aria-label="Expandera vänsterkolumnen"
          title="Expandera vänsterkolumnen"
        >
          <span className="flex h-8 w-[12px] items-center overflow-hidden">
            <Image
              src="/bergbok-logo.png"
              alt=""
              width={124}
              height={30}
              priority
              className="h-auto w-28 max-w-none shrink-0"
            />
          </span>
        </button>
        <SidebarTrigger aria-label="Expandera vänsterkolumnen" className="mt-1 shrink-0" />
      </aside>

      <Sidebar {...props} collapsible="icon">
        <SidebarHeader className="aui-sidebar-header mb-2 border-b">
          <div className="aui-sidebar-header-content flex items-center justify-between group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1">
            <SidebarMenu className="min-w-0 flex-1 group-data-[collapsible=icon]:flex-none">
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="lg"
                  tooltip="Bergbok"
                  aria-label={state === "collapsed" ? "Expandera vänsterkolumnen" : "Bergbok"}
                  onClick={() => {
                    if (state === "collapsed") setOpen(true);
                  }}
                  className="group-data-[collapsible=icon]:justify-center"
                >
                  <div className="aui-sidebar-header-icon-wrapper flex h-8 w-28 items-center overflow-hidden group-data-[collapsible=icon]:w-[12px]">
                    <Image
                      src="/bergbok-logo.png"
                      alt="Bergbok"
                      width={124}
                      height={30}
                      priority
                      className="h-auto w-28 max-w-none shrink-0"
                    />
                  </div>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
            <SidebarTrigger
              aria-label={
                isMobile
                  ? openMobile
                    ? "Stäng vänsterkolumnen"
                    : "Expandera vänsterkolumnen"
                  : state === "collapsed"
                    ? "Expandera vänsterkolumnen"
                    : "Kollapsa vänsterkolumnen"
              }
              className="shrink-0"
            />
          </div>
        </SidebarHeader>
        <SidebarContent className="aui-sidebar-content px-3 py-3 group-data-[collapsible=icon]:hidden">
          {authState.stage === "authenticated" && (
            <div className="space-y-4">
              <div>
                <p className="font-medium">Fiktiv AB</p>
                <p className="text-xs text-muted-foreground">Bokföring 2026</p>
              </div>
              <div className="space-y-2">
                {summary?.periods.map((period) => (
                  <button
                    key={period.id}
                    type="button"
                    aria-current={selectedPeriodId === period.id ? "page" : undefined}
                    className={`w-full rounded border p-2 text-left text-sm transition-colors hover:bg-sidebar-accent ${
                      selectedPeriodId === period.id ? "border-[#006aa7] bg-sidebar-accent" : ""
                    }`}
                    onClick={() => onSelectPeriod(period.id)}
                  >
                    <div className="flex justify-between gap-2">
                      <span>{period.id}</span>
                      <span className="text-xs text-muted-foreground">
                        {statusLabel[period.status] ?? period.status}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {period.uploadCount} dokument
                    </div>
                  </button>
                ))}
              </div>
              <AuthPanel
                state={authState}
                busy={authBusy}
                error={authError}
                onAction={onAuthAction}
                onCancel={() => void onAuthAction({ type: "logout" })}
              />
            </div>
          )}
        </SidebarContent>
        <SidebarRail />
      </Sidebar>
    </>
  );
}
