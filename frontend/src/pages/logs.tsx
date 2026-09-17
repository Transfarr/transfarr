import { useEffect, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, FileText, LoaderCircle, RefreshCw, Search } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { apiRequest } from "@/lib/api";
import { protocolNames, type Protocol } from "@/lib/types";

type LogEntry = {
  id: number;
  timestamp: string;
  protocol: Protocol;
  user: string;
  action: string;
  path: string;
  destination: string;
  hostPath: string;
  remoteAddress: string;
  outcome: "success" | "failure" | "info";
  details: string;
};
type LogPage = { entries: LogEntry[]; nextCursor: number | null; retention: number; warning: string | null };

export function Logs() {
  const [search, setSearch] = useState("");
  const [protocol, setProtocol] = useState("");
  const [outcome, setOutcome] = useState("");
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const [live, setLive] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<LogPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const before = cursors[cursors.length - 1];

  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    setLoading(true);
    setData(null);
    setError("");
    setExpanded(null);
    const load = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const params = new URLSearchParams({ search, limit: "50" });
        if (protocol) params.set("protocol", protocol);
        if (outcome) params.set("outcome", outcome);
        if (before) params.set("before", String(before));
        const result = await apiRequest<LogPage>(`/api/v1/logs?${params}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setData(result); setError(""); }
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
      } finally {
        fetching = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    const delay = window.setTimeout(() => void load(), 200);
    const timer = live && !before ? window.setInterval(() => void load(), 5000) : undefined;
    return () => { controller.abort(); window.clearTimeout(delay); window.clearInterval(timer); };
  }, [search, protocol, outcome, before, live, refresh]);

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <PageHeader title="Logs" description="File activity across FTP, FTPS, SFTP, and SMB." />
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" className="size-4 accent-primary" checked={live} onChange={event => setLive(event.target.checked)} />
            Auto-refresh
          </label>
          <Button variant="outline" aria-label="Refresh logs" disabled={loading} onClick={() => setRefresh(value => value + 1)}>
            <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-3 left-3 size-4 text-muted-foreground" />
          <Input aria-label="Search logs" placeholder="Search user, action, path, or IP…" value={search} maxLength={200} className="pl-9" onChange={event => { setSearch(event.target.value); setCursors([null]); }} />
        </div>
        <div className="flex gap-3">
          <Select aria-label="Filter protocol" className="min-w-0 flex-1 sm:w-36" value={protocol} onChange={event => { setProtocol(event.target.value); setCursors([null]); }}>
            <option value="">All protocols</option>
            {Object.entries(protocolNames).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
          </Select>
          <Select aria-label="Filter result" className="min-w-0 flex-1 sm:w-36" value={outcome} onChange={event => { setOutcome(event.target.value); setCursors([null]); }}>
            <option value="">All results</option><option value="success">Success</option><option value="failure">Failed</option><option value="info">Info</option>
          </Select>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-red-500">Could not load logs: {error}</p>}
      {data?.warning && <p role="alert" className="text-sm text-amber-600">{data.warning}</p>}
      <div className="overflow-hidden rounded-xl border bg-card shadow-xs" aria-busy={loading}>
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Loading activity…</div>
        ) : !data?.entries.length ? (
          <div className="px-6 py-16 text-center">
            <FileText className="mx-auto mb-3 size-8 text-muted-foreground" />
            <p className="font-medium">{error ? "Logs unavailable" : search || protocol || outcome ? "No matching activity" : "No activity yet"}</p>
            <p className="mt-1 text-sm text-muted-foreground">{error ? "Try refreshing the logs." : search || protocol || outcome ? "Try another search or change the filters." : "New file operations and connections will appear here."}</p>
          </div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[840px] table-fixed text-left text-sm">
                <thead className="border-b bg-muted/40 text-xs text-muted-foreground"><tr>
                  <th className="w-36 px-4 py-3">Time</th><th className="w-36 px-4 py-3">Action</th><th className="w-32 px-4 py-3">User / Client</th><th className="w-20 px-3 py-3">Protocol</th><th className="px-4 py-3">Path / Details</th><th className="w-24 px-3 py-3">Result</th>
                </tr></thead>
                <tbody>
                  {data.entries.map(entry => (
                    <tr key={entry.id} className="border-b align-top last:border-0">
                      <td className="px-4 py-4 text-xs text-muted-foreground"><time dateTime={entry.timestamp} title={entry.timestamp} className="block tabular-nums">{new Date(entry.timestamp).toLocaleTimeString()}<span className="mt-1 block">{new Date(entry.timestamp).toLocaleDateString()}</span></time></td>
                      <td className="break-words px-4 py-4 font-medium">{entry.action}</td>
                      <td className="break-words px-4 py-4"><span className="font-medium">{entry.user || "Unknown"}</span><span className="mt-1 block text-xs text-muted-foreground">{entry.remoteAddress || "—"}</span></td>
                      <td className="px-3 py-4 text-xs text-muted-foreground">{protocolNames[entry.protocol]}</td>
                      <td className="min-w-0 px-4 py-4">
                        <button className="flex w-full items-start gap-2 text-left" aria-label={`Details for log ${entry.id}`} aria-expanded={expanded === entry.id} onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}>
                          <span className="min-w-0 flex-1 break-all font-mono text-xs">{entry.path || "—"}{entry.destination && <span className="mt-1 block text-muted-foreground">→ {entry.destination}</span>}</span>
                          <ChevronDown className={`size-3.5 shrink-0 text-muted-foreground ${expanded === entry.id ? "rotate-180" : ""}`} />
                        </button>
                        {expanded === entry.id && <div className="mt-3 space-y-2 break-all text-xs text-muted-foreground">{entry.hostPath && <p><span className="font-medium">Server path: </span><span className="font-mono">{entry.hostPath}</span></p>}<p>{entry.details || "No additional details"}</p><p>{entry.timestamp}</p></div>}
                      </td>
                      <td className="px-3 py-4"><span className={`rounded-md px-2 py-1 text-xs font-medium ${entry.outcome === "failure" ? "bg-red-500/10 text-red-500" : entry.outcome === "success" ? "bg-green-500/10 text-green-600 dark:text-green-400" : "bg-muted text-muted-foreground"}`}>{entry.outcome === "failure" ? "Failed" : entry.outcome === "success" ? "Success" : "Info"}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="divide-y md:hidden">
              {data.entries.map(entry => <article key={entry.id} className="space-y-2 p-4 text-sm">
                <div className="flex items-start justify-between gap-3"><p className="min-w-0 break-words font-medium">{entry.action}</p><span className={`shrink-0 text-xs ${entry.outcome === "failure" ? "text-red-500" : entry.outcome === "success" ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}>{entry.outcome === "failure" ? "Failed" : entry.outcome === "success" ? "Success" : "Info"}</span></div>
                <p className="break-all text-xs text-muted-foreground">{entry.user || "Unknown"} · {protocolNames[entry.protocol]} · {entry.remoteAddress || "Unknown client"}</p>
                {entry.path && <p className="break-all font-mono text-xs">{entry.path}</p>}
                {entry.destination && <p className="break-all font-mono text-xs">→ {entry.destination}</p>}
                <details className="text-xs text-muted-foreground"><summary className="cursor-pointer"><time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleString()}</time> · Details</summary><div className="mt-2 space-y-2 break-all">{entry.hostPath && <p>Server path: <span className="font-mono">{entry.hostPath}</span></p>}<p>{entry.details || "No additional details"}</p></div></details>
              </article>)}
            </div>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-4 text-xs text-muted-foreground">
        <p>Latest {(data?.retention || 100000).toLocaleString()} events retained. {before ? "Viewing older activity." : live ? "Refreshes every 5 seconds." : "Auto-refresh paused."}</p>
        <div className="flex items-center gap-2">
          <Button variant="outline" disabled={loading || cursors.length === 1} onClick={() => setCursors(value => value.slice(0, -1))}><ChevronLeft className="mr-1 size-4" />Newer</Button>
          <Button variant="outline" disabled={loading || !data?.nextCursor} onClick={() => setCursors(value => [...value, data!.nextCursor])}>Older<ChevronRight className="ml-1 size-4" /></Button>
        </div>
      </div>
    </section>
  );
}
