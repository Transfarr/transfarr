import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import {
  Folder,
  Users,
  UserRound,
  Plus,
  Pencil,
  Trash2,
  X,
  Menu,
  LoaderCircle,
  Search,
  FolderOpen,
  Network,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/page-header";
import { ThemeSwitch } from "@/components/theme-switch";
import { ViewToggle } from "@/components/view-toggle";
import { PathPicker } from "@/components/path-picker";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ProtocolSettings } from "@/pages/protocol-settings";
import { Logs } from "@/pages/logs";
import { apiRequest } from "@/lib/api";
import {
  protocolNames,
  type Protocol,
  type State,
  type Settings,
  type User,
  type SharedFolder,
  type ViewMode,
} from "@/lib/types";

export function App() {
  const [menu, setMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const mobileNavigation = useRef<HTMLElement>(null);
  const [mobileActions, setMobileActions] = useState<HTMLDivElement | null>(null);
  const location = useLocation();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await apiRequest<Settings>("/api/v1/settings"));
      setSettingsError("");
    } catch (error) {
      setSettingsError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    void refreshSettings();
    const timer = window.setInterval(() => void refreshSettings(), 5000);
    return () => window.clearInterval(timer);
  }, [refreshSettings]);
  useEffect(() => {
    setMenu(false);
  }, [location.pathname]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    let swipe: { identifier: number; x: number; y: number; horizontal: boolean } | null = null;

    function onTouchStart(event: TouchEvent) {
      swipe = null;
      if (!menuButton.current?.getClientRects().length || event.touches.length !== 1
        || event.defaultPrevented || document.querySelector("dialog[open]")) return;

      const touch = event.touches[0];
      if (menu) {
        if (!mobileNavigation.current?.contains(event.target as Node)) return;
      } else if (touch.clientX > 20) return;

      // Reserve the left edge for the drawer instead of browser navigation.
      if (touch.clientX <= 20 && event.cancelable) event.preventDefault();
      swipe = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY, horizontal: false };
    }

    function onTouchMove(event: TouchEvent) {
      if (!swipe) return;
      if (event.touches.length !== 1 || event.touches[0].identifier !== swipe.identifier) {
        swipe = null;
        return;
      }
      const dx = event.touches[0].clientX - swipe.x;
      const dy = event.touches[0].clientY - swipe.y;
      if (!swipe.horizontal) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 10) return;
        if (Math.abs(dy) >= Math.abs(dx) || (menu ? dx > 0 : dx < 0)) {
          swipe = null;
          return;
        }
        swipe.horizontal = true;
      }
      if (event.cancelable) event.preventDefault();
    }

    function onTouchEnd(event: TouchEvent) {
      const start = swipe;
      swipe = null;
      if (!start || event.touches.length || !menuButton.current?.getClientRects().length) return;
      const touch = Array.from(event.changedTouches).find(touch => touch.identifier === start.identifier);
      if (!touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      // Avoid following sidebar links after dragging across them.
      if (start.horizontal && event.cancelable) event.preventDefault();
      if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && (menu ? dx < 0 : dx > 0)) {
        if (event.cancelable) event.preventDefault();
        setMenu(!menu);
      }
    }

    function cancelSwipe() {
      swipe = null;
    }

    document.addEventListener("touchstart", onTouchStart, { passive: false });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd, { passive: false });
    document.addEventListener("touchcancel", cancelSwipe);
    window.addEventListener("resize", cancelSwipe);
    return () => {
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchmove", onTouchMove);
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("touchcancel", cancelSwipe);
      window.removeEventListener("resize", cancelSwipe);
    };
  }, [menu, location.pathname]);
  const pageTitle = location.pathname.startsWith("/settings/")
    ? protocolNames[location.pathname.split("/")[2] as Protocol] || "Settings"
    : location.pathname === "/users"
      ? "Users"
      : location.pathname === "/logs" ? "Logs" : "Folders";
  return (
    <div className="min-h-dvh bg-muted/25 md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
      {menu && (
        <button
          aria-label="Close navigation"
          onClick={() => setMenu(false)}
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
        />
      )}
      <aside
        ref={mobileNavigation}
        id="sidebar"
        className={`${menu ? "fixed inset-y-0 left-0 z-50 flex w-60" : "hidden"} top-0 h-dvh flex-col border-r bg-sidebar text-sidebar-foreground md:sticky md:flex`}
      >
        <div className="flex h-20 items-center px-5">
          <NavLink to="/folders" className="flex items-center gap-3 rounded-lg">
            <img
              src="/logo.png"
              alt=""
              className="size-11 shrink-0 object-contain"
            />
            <span>
              <span className="block text-base leading-none font-semibold tracking-tight">
                Transfarr
              </span>
              <span className="mt-1 block text-[11px] leading-none text-muted-foreground">
                File Center
              </span>
            </span>
          </NavLink>
        </div>
        <nav
          aria-label="Main navigation"
          className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
        >
          <p className="mb-2 px-2 text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            Manage
          </p>
          <div className="flex flex-col gap-1">
            {[
              { label: "Folders", to: "/folders", icon: Folder },
              { label: "Users", to: "/users", icon: Users },
            ].map(({ label, to, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring ${isActive ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-xs" : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"}`
                }
              >
                <Icon className="size-4" />
                {label}
              </NavLink>
            ))}
          </div>
          <p className="mt-6 mb-2 px-2 text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
            Settings
          </p>
          <div className="flex flex-col gap-1">
            {(["smb", "ftp", "ftps", "sftp"] as const).map((protocol) => (
              <NavLink
                key={protocol}
                to={`/settings/${protocol}`}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring ${isActive ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-xs" : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"}`
                }
              >
                <span
                  role="img"
                  aria-label={
                    !settings
                      ? "Checking service"
                      : !settings.protocols[protocol].enabled
                        ? "Unused — no folders use this service"
                        : (settings.protocols[protocol].conflict || settings.protocols[protocol].discovery?.error)
                          ? "Port conflict"
                          : settings.protocols[protocol].running
                            ? "Online"
                            : "Service error"
                  }
                  title={
                    !settings
                      ? "Checking service"
                      : !settings.protocols[protocol].enabled
                        ? "Unused — no folders use this service"
                        : (settings.protocols[protocol].conflict || settings.protocols[protocol].discovery?.error)
                          ? "Port conflict"
                          : settings.protocols[protocol].running
                            ? "Online"
                            : "Service error"
                  }
                  className="flex size-4 shrink-0 items-center justify-center"
                >
                  <span
                    className={`size-2 rounded-full ${!settings || !settings.protocols[protocol].enabled ? "bg-gray-400" : settings.protocols[protocol].running && !settings.protocols[protocol].discovery?.error ? "bg-green-500 shadow-[0_0_0_3px_rgba(34,197,94,0.14)]" : "bg-red-500 shadow-[0_0_0_3px_rgba(239,68,68,0.14)]"}`}
                  />
                </span>
                {protocolNames[protocol]}
              </NavLink>
            ))}
          </div>
          <p className="mt-6 mb-2 px-2 text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">Debug</p>
          <NavLink to="/logs" className={({ isActive }) =>
            `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring ${isActive ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-xs" : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"}`
          }><FileText className="size-4" />Logs</NavLink>
        </nav>
        <div className="shrink-0 border-t px-3 pt-3 pb-5">
          <ThemeSwitch />
        </div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b bg-sidebar/95 px-4 backdrop-blur md:hidden">
          <button
            ref={menuButton}
            aria-label="Open navigation"
            aria-expanded={menu}
            aria-controls="sidebar"
            onClick={() => setMenu(true)}
            className="flex size-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted"
          >
            <Menu className="size-5" />
          </button>
          <span className="text-lg font-semibold tracking-tight">
            {pageTitle}
          </span>
          <div ref={setMobileActions} className="ml-auto shrink-0" />
        </header>
        <main className="min-w-0 max-w-full">
          <div className="mx-auto min-w-0 w-full max-w-7xl px-5 py-8 sm:px-8 sm:py-10 lg:px-10">
            {settingsError && (
              <p role="alert" className="mb-4 text-sm text-red-500">
                Could not refresh port status: {settingsError}
              </p>
            )}
            <Routes>
              <Route path="/logs" element={<Logs />} />
              <Route path="/folders" element={<Resources kind="folders" mobileActions={mobileActions} />} />
              <Route path="/users" element={<Resources kind="users" mobileActions={mobileActions} />} />
              {(["smb", "ftp", "ftps", "sftp"] as const).map((protocol) => (
                <Route
                  key={protocol}
                  path={`/settings/${protocol}`}
                  element={
                    settings ? (
                      <ProtocolSettings
                        key={protocol}
                        protocol={protocol}
                        settings={settings}
                        onSaved={refreshSettings}
                      />
                    ) : (
                      <div
                        className="max-w-3xl animate-pulse space-y-5"
                        aria-label="Loading settings"
                      >
                        <div className="h-8 w-40 rounded-lg bg-muted" />
                        <div className="h-64 rounded-xl bg-muted" />
                      </div>
                    )
                  }
                />
              ))}
              <Route
                path="/settings"
                element={<Navigate to="/settings/smb" replace />}
              />
              <Route path="*" element={<Navigate to="/folders" replace />} />
            </Routes>
          </div>
        </main>
      </div>
    </div>
  );
}

function Resources({ kind, mobileActions }: {
  kind: "users" | "folders";
  mobileActions: HTMLDivElement | null;
}) {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<ViewMode>(() => {
    try {
      return window.localStorage.getItem("transfarr-view") === "table"
        ? "table"
        : "cards";
    } catch {
      return "cards";
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem("transfarr-view", view);
    } catch {
      // Keep the selected view when browser storage is unavailable.
    }
  }, [view]);
  const [editing, setEditing] = useState<User | SharedFolder | "new" | null>(
    null,
  );
  const [deleting, setDeleting] = useState<User | SharedFolder | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      setState(await apiRequest<State>("/api/v1/state"));
      setError("");
    } catch (error) {
      setError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    void reload();
    const timer = window.setInterval(reload, 10000);
    return () => clearInterval(timer);
  }, [reload]);
  useEffect(() => {
    setSearch("");
    setEditing(null);
    setDeleting(null);
  }, [kind]);
  const title = kind === "folders" ? "Folders" : "Users";
  const singular = kind === "folders" ? "Folder" : "User";
  const items =
    state?.[kind].filter((item) =>
      ("username" in item ? item.username : item.name)
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) || [];
  return (
    <section>
      {mobileActions && createPortal(
        <Button onClick={() => setEditing("new")}>
          <Plus className="mr-2 size-4" />
          Create {singular}
        </Button>,
        mobileActions,
      )}
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <PageHeader
          title={title}
          description={
            kind === "folders"
              ? "Shared folders and the people who can access them."
              : "Manage accounts and access to your shared folders."
          }
        />
        <div className="hidden items-center gap-2 sm:flex">
          <Button className="hidden md:inline-flex" onClick={() => setEditing("new")}>
            <Plus className="mr-2 size-4" />
            Create {singular}
          </Button>
          <ViewToggle value={view} onChange={setView} />
        </div>
      </div>
      {error && (
        <div
          role="alert"
          className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm"
        >
          {error}
          <Button variant="outline" className="ml-3" onClick={reload}>
            Retry
          </Button>
        </div>
      )}
      {!state && !error && (
        <div className="flex h-56 items-center justify-center text-muted-foreground">
          <LoaderCircle className="size-5 animate-spin" />
        </div>
      )}
      {state && (
        <>
          {Object.entries(state.protocols).some(
            ([, status]) => status.enabled && !status.running,
          ) && (
            <div
              role="alert"
              className="mb-5 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm"
            >
              {Object.entries(state.protocols)
                .filter(([, status]) => status.enabled && !status.running)
                .map(([name, status]) => (
                  <p key={name}>
                    {protocolNames[name as Protocol]}:{" "}
                    {status.error || "Not running"}
                  </p>
                ))}
            </div>
          )}
          {state[kind].length > 0 && (
            <div className="relative mb-5 max-w-sm">
              <Search className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
              <Input
                aria-label={`Search ${kind}`}
                placeholder={`Search ${kind}…`}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
              />
            </div>
          )}
          {items.length === 0 ? (
            <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed bg-card/50 px-6 text-center">
              {kind === "folders" ? (
                <FolderOpen className="mb-4 size-9 text-muted-foreground" />
              ) : (
                <Users className="mb-4 size-9 text-muted-foreground" />
              )}
              <h2 className="text-base font-medium">
                {search ? `No matching ${kind}` : `No ${kind} yet`}
              </h2>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                {search
                  ? "Try a different search."
                  : kind === "folders"
                    ? "Choose a folder, assign users, and enable your preferred protocols."
                    : "Create an account to give someone access to your folders."}
              </p>
              {!search && (
                <Button
                  variant="outline"
                  className="mt-5"
                  onClick={() => setEditing("new")}
                >
                  <Plus className="mr-2 size-4" />
                  Create {singular}
                </Button>
              )}
            </div>
          ) : (
            <>
              <div
                className={
                  view === "cards"
                    ? "grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
                    : "grid gap-4 sm:hidden"
                }
              >
                {items.map((item) => (
                  <Card key={item.id} className="gap-5 p-5 shadow-none">
                    <CardHeader className="flex flex-row items-center gap-3 p-0">
                      <div
                        className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${kind === "folders" ? "bg-violet-500/10 text-violet-600 dark:text-violet-400" : "bg-blue-500/10 text-blue-600 dark:text-blue-400"}`}
                      >
                        {kind === "folders" ? (
                          <Folder className="size-5" />
                        ) : (
                          <UserRound className="size-5" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <CardTitle className="truncate text-base">
                          {"username" in item ? item.username : item.name}
                        </CardTitle>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {"path" in item
                            ? item.path
                            : `${state.folders.filter((folder) => folder.permissions[item.id]).length} shared folders`}
                        </p>
                      </div>
                      <button
                        aria-label={`Edit ${"username" in item ? item.username : item.name}`}
                        onClick={() => setEditing(item)}
                        className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        aria-label={`Delete ${"username" in item ? item.username : item.name}`}
                        onClick={() => {
                          setDeleting(item);
                          setDeleteError(null);
                        }}
                        className="rounded-lg p-1.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-500"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </CardHeader>
                    {"protocols" in item && (
                      <CardContent className="space-y-3 p-0">
                          <div className="flex items-center gap-2 text-sm">
                            <Network className="size-4 text-muted-foreground" />
                            <span className="text-muted-foreground">
                              Protocols
                            </span>
                            <div className="ml-auto flex flex-wrap justify-end gap-1">
                              {item.protocols.length ? (
                                item.protocols.map((protocol) => (
                                  <Badge key={protocol} variant="outline">
                                    {protocolNames[protocol]}
                                  </Badge>
                                ))
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  Disabled
                                </span>
                              )}
                            </div>
                          </div>
                          <div className="flex items-start gap-2 text-sm">
                            <Users className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                            <span className="text-muted-foreground">Users</span>
                            <div className="ml-auto space-y-1 text-right text-xs">
                              {Object.entries(item.permissions).length ? (
                                Object.entries(item.permissions).map(
                                  ([id, access]) => (
                                    <p key={id}>
                                      {
                                        id === "anonymous" ? "Anonymous" : state.users.find(
                                          (user) => user.id === id,
                                        )?.username
                                      }
                                      <span className="ml-2 text-muted-foreground">
                                        {access === "write"
                                          ? "Read & write"
                                          : "Read only"}
                                      </span>
                                    </p>
                                  ),
                                )
                              ) : (
                                <span className="text-muted-foreground">
                                  No access assigned
                                </span>
                              )}
                            </div>
                          </div>
                      </CardContent>
                    )}
                  </Card>
                ))}
              </div>
              {view === "table" && (
                <div className="hidden overflow-hidden rounded-xl border bg-card shadow-xs sm:block">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-5 py-3">{singular}</th>
                        <th className="px-5 py-3">
                          {kind === "folders" ? "Protocols" : "Folders"}
                        </th>
                        {kind === "folders" && (
                          <th className="px-5 py-3">Users</th>
                        )}
                        <th className="px-5 py-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item) => (
                        <tr key={item.id} className="border-b last:border-0">
                          <td className="px-5 py-4 font-medium">
                            {"name" in item ? item.name : item.username}
                            {"path" in item && (
                              <p className="mt-1 font-mono text-xs font-normal text-muted-foreground">
                                {item.path}
                              </p>
                            )}
                          </td>
                          <td className="px-5 py-4 text-xs">
                            {"protocols" in item
                              ? item.protocols
                                  .map((protocol) => protocolNames[protocol])
                                  .join(", ") || "Disabled"
                              : state.folders.filter(
                                  (folder) => folder.permissions[item.id],
                                ).length}
                          </td>
                          {"permissions" in item && (
                            <td className="px-5 py-4 text-xs">
                              {Object.keys(item.permissions).length}
                            </td>
                          )}
                          <td className="px-5 py-4 text-right">
                            <Button
                              variant="ghost"
                              aria-label={`Edit ${"name" in item ? item.name : item.username}`}
                              onClick={() => setEditing(item)}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              aria-label={`Delete ${"name" in item ? item.name : item.username}`}
                              onClick={() => {
                                setDeleting(item);
                                setDeleteError(null);
                              }}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {editing && (
            <Editor
              kind={kind}
              item={editing}
              state={state}
              onClose={() => setEditing(null)}
              onSaved={async () => {
                setEditing(null);
                await reload();
              }}
            />
          )}
        </>
      )}
      <DeleteConfirmDialog
        open={Boolean(deleting)}
        deleting={busy}
        title={`Delete ${deleting && ("name" in deleting ? deleting.name : deleting.username)}?`}
        description={
          kind === "folders"
            ? "This removes the share and disconnects active transfers. The files on disk are kept."
            : "This removes the account and all its folder permissions."
        }
        error={deleteError}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          setBusy(true);
          try {
            await apiRequest(`/api/v1/${kind}/${deleting!.id}`, {
              method: "DELETE",
            });
            setDeleting(null);
            await reload();
          } catch (error) {
            setDeleteError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      />
    </section>
  );
}

function Editor({
  kind,
  item,
  state,
  onClose,
  onSaved,
}: {
  kind: "users" | "folders";
  item: User | SharedFolder | "new";
  state: State;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const existing = item === "new" ? null : item;
  const folder = existing && "path" in existing ? existing : null;
  const [name, setName] = useState(
    existing
      ? "username" in existing
        ? existing.username
        : existing.name
      : "",
  );
  const [password, setPassword] = useState("");
  const [folderPath, setFolderPath] = useState(folder?.path || "");
  const [protocols, setProtocols] = useState<Protocol[]>(
    folder?.protocols || ["sftp"],
  );
  const [permissions, setPermissions] = useState<
    Record<string, "read" | "write">
  >(folder?.permissions || {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="editor-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
      className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2.5rem)] max-w-xl overflow-y-auto rounded-2xl border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/45"
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            await apiRequest(
              `/api/v1/${kind}${existing ? `/${existing.id}` : ""}`,
              {
                method: existing ? "PUT" : "POST",
                body: JSON.stringify(
                  kind === "users"
                    ? { username: name, password }
                    : { name, path: folderPath, protocols, permissions },
                ),
              },
            );
            await onSaved();
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex items-center justify-between border-b px-6 py-4">
          <h2 id="editor-title" className="text-lg font-semibold">
            {existing ? "Edit" : "Create"}{" "}
            {kind === "users" ? "User" : "Folder"}
          </h2>
          <button
            type="button"
            disabled={busy}
            aria-label="Close dialog"
            onClick={onClose}
            className="rounded-lg p-2 text-muted-foreground hover:bg-muted"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="space-y-6 p-6">
          <label className="block space-y-2 text-sm font-medium">
            <span>{kind === "users" ? "Username" : "Name"}</span>
            <Input
              required
              autoFocus
              value={name}
              maxLength={64}
              autoComplete="off"
              onChange={(event) => {
                const value = event.target.value;
                setName(value);
                event.target.setCustomValidity(
                  kind === "users" && value.trim().toLowerCase() === "anonymous"
                    ? '“Anonymous” is reserved for anonymous folder access.'
                    : "",
                );
              }}
              placeholder={kind === "users" ? "e.g. alex" : "e.g. Media"}
            />
          </label>
          {kind === "users" ? (
            <label className="block space-y-2 text-sm font-medium">
              <span>Password</span>
              <Input
                required={!existing}
                minLength={8}
                maxLength={1024}
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={
                  existing
                    ? "Leave empty to keep the current password"
                    : "At least 8 characters"
                }
              />
            </label>
          ) : (
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium">Folder</label>
                <PathPicker
                  source="host"
                  required
                  initialOpen={!existing}
                  rootPath={state.root}
                  value={folderPath}
                  onChange={setFolderPath}
                  placeholder={`${state.root}/media`}
                />
                <p className="text-xs text-muted-foreground">
                  Select a folder on the server to share.
                </p>
              </div>
              <fieldset>
                <legend className="mb-3 text-sm font-medium">Protocols</legend>
                <div className="grid grid-cols-2 gap-2">
                  {(Object.keys(protocolNames) as Protocol[]).map(
                    (protocol) => (
                      <label
                        key={protocol}
                        className="flex cursor-pointer items-center gap-2.5 rounded-lg border bg-card px-3 py-3 text-sm"
                      >
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={protocols.includes(protocol)}
                          onChange={(event) =>
                            setProtocols(
                              event.target.checked
                                ? [...protocols, protocol]
                                : protocols.filter(
                                    (value) => value !== protocol,
                                  ),
                            )
                          }
                        />
                        <span>{protocolNames[protocol]}</span>
                      </label>
                    ),
                  )}
                </div>
              </fieldset>
              <fieldset>
                <legend className="mb-1 text-sm font-medium">
                  Users
                </legend>
                <p className="mb-3 text-xs text-muted-foreground">
                  Select who can access this folder. Anonymous access does not require a password.
                </p>
                  <div className="overflow-hidden rounded-lg border">
                    {[{ id: "anonymous", username: "Anonymous" }, ...state.users].map((user) => (
                      <div
                        key={user.id}
                        className="flex items-center gap-3 border-b px-3 py-2.5 last:border-0"
                      >
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-sm">
                          <input
                            type="checkbox"
                            className="size-4 accent-primary"
                            checked={Boolean(permissions[user.id])}
                            onChange={(event) =>
                              setPermissions((current) => {
                                const next = { ...current };
                                if (event.target.checked)
                                  next[user.id] = "read";
                                else delete next[user.id];
                                return next;
                              })
                            }
                          />
                          <span className="truncate">{user.username}</span>
                        </label>
                        <Select
                          aria-label={`Permissions for ${user.username}`}
                          disabled={!permissions[user.id]}
                          value={permissions[user.id] || "read"}
                          onChange={(event) =>
                            setPermissions({
                              ...permissions,
                              [user.id]: event.target.value as "read" | "write",
                            })
                          }
                          className="w-36"
                        >
                          <option value="read">Read only</option>
                          <option value="write">Read & write</option>
                        </Select>
                      </div>
                    ))}
                  </div>
              </fieldset>
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-500">
              {error}
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t px-6 py-4">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            {busy && <LoaderCircle className="mr-2 size-4 animate-spin" />}
            {existing
              ? "Save Changes"
              : `Create ${kind === "users" ? "User" : "Folder"}`}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
