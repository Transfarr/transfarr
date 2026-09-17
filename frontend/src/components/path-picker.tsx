import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowUp,
  ChevronRight,
  File,
  Folder,
  FolderPlus,
  LoaderCircle,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/api";

export function PathPicker({
  image,
  rootPath,
  initialOpen = false,
  onChange,
  placeholder,
  required,
  source,
  value,
}: {
  image?: string;
  rootPath: string;
  initialOpen?: boolean;
  onChange: (value: string) => void;
  placeholder: string;
  required?: boolean;
  source: "host" | "device" | "image";
  value: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const browseButton = useRef<HTMLButtonElement>(null);
  const browserDialog = useRef<HTMLDialogElement>(null);
  const browserId = useId();
  const [open, setOpen] = useState(initialOpen);
  const [editingPath, setEditingPath] = useState(false);
  const [requestPath, setRequestPath] = useState(
    rootPath.replace(/\/$/, "") + "/",
  );
  const [entries, setEntries] = useState<
    Array<{ path: string; directory: boolean }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [folderCreating, setFolderCreating] = useState(false);
  const [folderError, setFolderError] = useState("");

  const root = rootPath.replace(/\/$/, "") + "/";
  const separator = requestPath.endsWith("/")
    ? requestPath.length - 1
    : requestPath.lastIndexOf("/");
  const currentDirectory = requestPath.endsWith("/")
    ? requestPath
    : `${requestPath.slice(0, separator + 1) || "/"}`;
  const pathParts = currentDirectory
    .slice(root.length)
    .split("/")
    .filter(Boolean);
  const atRoot = currentDirectory === root;

  useEffect(() => {
    if (!open) return;
    const dialog = browserDialog.current;
    let cancelled = false;
    // The editor opens in its own effect. Open above it after those effects,
    // including when the picker opens automatically with a new folder.
    queueMicrotask(() => {
      if (!cancelled && dialog && !dialog.open) dialog.showModal();
    });
    return () => {
      cancelled = true;
      dialog?.close();
      browseButton.current?.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      setEntries([]);
      return;
    }

    if (
      !requestPath.startsWith("/") ||
      (source === "device" &&
        requestPath !== "/dev" &&
        !requestPath.startsWith("/dev/")) ||
      (source === "image" && !image)
    ) {
      setEntries([]);
      setLoading(false);
      setError(
        source === "image" && !image
          ? "Enter an image before browsing its files."
          : "Enter an absolute path.",
      );
      return;
    }

    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timeout = window.setTimeout(() => {
      const query = new URLSearchParams({
        source,
        path: requestPath,
      });
      if (image) query.set("image", image);

      void apiRequest<Array<{ path: string; directory: boolean }>>(
        `/api/v1/paths?${query}`,
        { signal: controller.signal },
      )
        .then((result) => {
          setEntries(result);
          setLoading(false);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError")
            return;
          setEntries([]);
          setLoading(false);
          setError("This location could not be opened.");
        });
    }, 150);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [image, open, requestPath, source]);

  useEffect(() => {
    if (!open) return;

    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (editingPath) {
        setEditingPath(false);
        return;
      }
      if (creatingFolder && !folderCreating) {
        setCreatingFolder(false);
        setNewFolderName("");
        setFolderError("");
        return;
      }
      if (folderCreating) return;
      setOpen(false);
    };

    document.addEventListener("keydown", closeOnEscape, true);
    return () => document.removeEventListener("keydown", closeOnEscape, true);
  }, [creatingFolder, editingPath, folderCreating, open]);

  return (
    <div className="relative min-w-0">
      <Input
        ref={input}
        required={required}
        aria-label="Folder"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        placeholder={placeholder}
        autoComplete="off"
        className="pr-10 font-mono text-xs"
      />
      <button
        ref={browseButton}
        type="button"
        aria-label={
          source === "host"
            ? "Browse host files"
            : source === "device"
              ? "Browse devices"
              : "Browse image files"
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? browserId : undefined}
        onClick={() => {
          const nextPath = value || root;
          setRequestPath(nextPath.endsWith("/") ? nextPath : `${nextPath}/`);
          setEditingPath(false);
          setCreatingFolder(false);
          setNewFolderName("");
          setFolderError("");
          setOpen(true);
        }}
        className="absolute top-1/2 right-1 flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Folder className="size-4" />
      </button>
      {open &&
        createPortal(
          <dialog
            ref={browserDialog}
            id={browserId}
            aria-labelledby={`${browserId}-title`}
            onCancel={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!folderCreating) setOpen(false);
            }}
            className="fixed inset-0 m-auto h-[85dvh] max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-3xl overflow-hidden rounded-2xl border bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/45 sm:h-[70dvh] sm:max-h-[min(38rem,calc(100dvh-2rem))]"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !folderCreating)
                setOpen(false);
            }}
          >
            <div
              className="relative flex h-full min-h-0 min-w-0 w-full flex-col"
            >
              <div className="flex shrink-0 items-center justify-between border-b px-5 py-4 sm:px-6">
                <div className="min-w-0">
                  <h2 id={`${browserId}-title`} className="font-semibold">
                    {source === "host"
                      ? "Browse Folders"
                      : source === "device"
                        ? "Browse devices"
                        : "Browse Image Files"}
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Navigate to the folder you want to share.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  disabled={folderCreating}
                  aria-label="Close file browser"
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="size-4" />
                </button>
              </div>

              <div className="flex min-h-0 flex-1 flex-col p-5 sm:p-6">
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={atRoot}
                    aria-label="Go to parent folder"
                    onClick={() => {
                      const withoutTrailingSlash = currentDirectory.replace(
                        /\/$/,
                        "",
                      );
                      const parent = `${withoutTrailingSlash.slice(0, withoutTrailingSlash.lastIndexOf("/") + 1) || root}`;
                      onChange(parent);
                      setRequestPath(parent);
                    }}
                    className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground shadow-xs hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
                  >
                    <ArrowUp className="size-4" />
                  </button>
                  {editingPath ? (
                    <Input
                      autoFocus
                      value={requestPath}
                      aria-label="Path"
                      onFocus={(event) => event.currentTarget.select()}
                      onBlur={() => setEditingPath(false)}
                      onChange={(event) => {
                        onChange(event.target.value);
                        setRequestPath(event.target.value);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        setEditingPath(false);
                      }}
                      className="font-mono text-xs"
                    />
                  ) : (
                    <nav
                      aria-label="Current path"
                      title="Double-click to edit path"
                      onDoubleClick={() => setEditingPath(true)}
                      className="flex h-9 min-w-0 flex-1 cursor-text items-center overflow-x-auto rounded-lg border bg-background px-1 font-mono text-xs shadow-xs"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onChange(root);
                          setRequestPath(root);
                        }}
                        className="shrink-0 rounded px-2 py-1 hover:bg-muted"
                      >
                        {root.replace(/\/$/, "")}
                      </button>
                      {pathParts.map((part, index) => {
                        const leadingParts = root.split("/").filter(Boolean);
                        const path = `/${[...leadingParts, ...pathParts.slice(0, index + 1)].join("/")}/`;
                        return (
                          <span
                            key={path}
                            className="flex shrink-0 items-center"
                          >
                            <ChevronRight className="size-3 text-muted-foreground" />
                            <button
                              type="button"
                              onClick={() => {
                                onChange(path);
                                setRequestPath(path);
                              }}
                              className="rounded px-2 py-1 hover:bg-muted"
                            >
                              {part}
                            </button>
                          </span>
                        );
                      })}
                    </nav>
                  )}
                  {source === "host" && (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 shrink-0"
                      disabled={creatingFolder}
                      onClick={() => {
                        setCreatingFolder(true);
                        setNewFolderName("");
                        setFolderError("");
                      }}
                    >
                      <FolderPlus className="mr-1.5 size-4" />
                      New Folder
                    </Button>
                  )}
                </div>

                <div className="mt-3 grid shrink-0 grid-cols-[minmax(0,1fr)_5rem_1.5rem] gap-3 border-b px-3 pb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  <span>Name</span>
                  <span>Type</span>
                  <span />
                </div>

                <div
                  role="listbox"
                  aria-label="Files and folders"
                  className="min-h-0 flex-1 overflow-y-auto py-1.5"
                >
                  {loading ? (
                    <div className="flex h-full min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
                      <LoaderCircle className="size-4 animate-spin" />
                      Loading files…
                    </div>
                  ) : error ? (
                    <div className="flex h-full min-h-32 items-center justify-center px-6 text-center text-sm text-muted-foreground">
                      {error}
                    </div>
                  ) : entries.length === 0 ? (
                    <div className="flex h-full min-h-32 items-center justify-center text-sm text-muted-foreground">
                      This folder is empty.
                    </div>
                  ) : (
                    entries.map((entry) => {
                      const name =
                        entry.path.replace(/\/$/, "").split("/").pop() || "/";
                      return (
                        <button
                          key={entry.path}
                          type="button"
                          role="option"
                          aria-selected={entry.path === value}
                          onClick={() => {
                            onChange(entry.path);
                            if (entry.directory) {
                              setRequestPath(entry.path);
                            } else {
                              setOpen(false);
                            }
                          }}
                          className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_5rem_1.5rem] items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-accent hover:text-accent-foreground aria-selected:bg-accent/70"
                        >
                          <span className="flex min-w-0 items-center gap-2.5">
                            {entry.directory ? (
                              <Folder className="size-4 shrink-0 fill-current text-amber-500" />
                            ) : (
                              <File className="size-4 shrink-0 text-muted-foreground" />
                            )}
                            <span className="truncate font-mono text-xs">
                              {name}
                            </span>
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {entry.directory ? "Folder" : "File"}
                          </span>
                          {entry.directory ? (
                            <ChevronRight className="size-4 text-muted-foreground" />
                          ) : (
                            <span />
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>

              {source === "host" && creatingFolder && (
                <div
                  className="absolute inset-0 z-20 flex items-end justify-center bg-black/45 p-0 sm:items-center sm:p-5"
                  onMouseDown={(event) => {
                    if (event.target !== event.currentTarget || folderCreating)
                      return;
                    setCreatingFolder(false);
                    setNewFolderName("");
                    setFolderError("");
                  }}
                >
                  <form
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby={`${browserId}-new-folder-title`}
                    onSubmit={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      const directoryName = newFolderName.trim();
                      if (
                        !directoryName ||
                        [".", ".."].includes(directoryName) ||
                        directoryName.includes("/")
                      ) {
                        setFolderError("Enter a valid folder name.");
                        return;
                      }
                      setFolderCreating(true);
                      setFolderError("");
                      void apiRequest<{ path: string; directory: true }>(
                        "/api/v1/paths",
                        {
                          method: "POST",
                          body: JSON.stringify({
                            parentPath: currentDirectory,
                            directoryName,
                          }),
                        },
                      )
                        .then((created) => {
                          onChange(created.path);
                          setRequestPath(created.path);
                          setCreatingFolder(false);
                          setNewFolderName("");
                        })
                        .catch((requestError) => {
                          setFolderError(
                            requestError instanceof Error
                              ? requestError.message
                              : "Folder could not be created.",
                          );
                        })
                        .finally(() => setFolderCreating(false));
                    }}
                    className="flex min-w-0 w-full max-w-md flex-col overflow-hidden rounded-t-2xl border bg-background shadow-2xl sm:rounded-2xl"
                  >
                    <div className="flex items-center justify-between border-b px-5 py-4">
                      <h3
                        id={`${browserId}-new-folder-title`}
                        className="font-semibold"
                      >
                        New Folder
                      </h3>
                      <button
                        type="button"
                        disabled={folderCreating}
                        aria-label="Close new folder dialog"
                        onClick={() => {
                          setCreatingFolder(false);
                          setNewFolderName("");
                          setFolderError("");
                        }}
                        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                      >
                        <X className="size-4" />
                      </button>
                    </div>
                    <div className="p-5">
                      <div className="flex h-10 min-w-0 overflow-hidden rounded-lg border bg-background shadow-xs focus-within:border-foreground/30 focus-within:ring-2 focus-within:ring-ring/30">
                        <span
                          title={currentDirectory}
                          className="flex min-w-0 max-w-[60%] shrink-0 items-center border-r bg-muted/30 px-3 font-mono text-xs text-muted-foreground"
                        >
                          <span className="truncate">{currentDirectory}</span>
                        </span>
                        <Input
                          id={`${browserId}-folder-name`}
                          autoFocus
                          required
                          aria-label="Folder name"
                          value={newFolderName}
                          disabled={folderCreating}
                          onChange={(event) =>
                            setNewFolderName(event.target.value)
                          }
                          placeholder="New folder"
                          className="h-full min-w-16 flex-1 rounded-none border-0 font-mono text-xs shadow-none focus:ring-0"
                        />
                      </div>
                      {folderError && (
                        <p
                          role="alert"
                          className="mt-2 text-sm text-red-600 dark:text-red-400"
                        >
                          {folderError}
                        </p>
                      )}
                    </div>
                    <div className="flex justify-end gap-2 border-t px-5 py-4">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={folderCreating}
                        onClick={() => {
                          setCreatingFolder(false);
                          setNewFolderName("");
                          setFolderError("");
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        disabled={folderCreating || !newFolderName.trim()}
                      >
                        {folderCreating && (
                          <LoaderCircle className="mr-2 size-4 animate-spin" />
                        )}
                        Create Folder
                      </Button>
                    </div>
                  </form>
                </div>
              )}

              <div className="flex shrink-0 items-center justify-between gap-4 border-t bg-background px-5 py-4 sm:px-6">
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                  {currentDirectory}
                </span>
                <div className="flex shrink-0 gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={folderCreating}
                    onClick={() => setOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      if (loading || error) return;
                      onChange(currentDirectory);
                      setOpen(false);
                    }}
                  >
                    Select folder
                  </Button>
                </div>
              </div>
            </div>
          </dialog>,
          document.body,
        )}
    </div>
  );
}
