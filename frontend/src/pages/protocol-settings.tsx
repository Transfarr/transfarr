import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { ApiError, apiRequest } from "@/lib/api";
import { protocolNames, type Protocol, type ProtocolStatus, type Settings } from "@/lib/types";

type PortCheck = { port: number; passiveMin?: number; passiveMax?: number; available: boolean; conflict: boolean; message: string };
const defaults = { smb: 445, ftp: 21, ftps: 990, sftp: 22 };
const descriptions = {
  smb: "Configure SMB connections to your shared folders.",
  ftp: "Configure FTP connections and passive file transfers.",
  ftps: "Configure encrypted FTP connections using implicit TLS.",
  sftp: "Configure secure file transfers over SSH.",
};

export function ProtocolSettings({ protocol, settings, onSaved }: {
  protocol: Protocol;
  settings: Settings;
  onSaved: () => Promise<void>;
}) {
  const status = settings.protocols[protocol];
  const [port, setPort] = useState(status.port === defaults[protocol] ? "" : String(status.port));
  const passive = protocol === "ftp" || protocol === "ftps";
  const range = passive ? settings.passiveRanges?.[protocol] : undefined;
  const canEditPassive = Boolean(range);
  const [passiveMin, setPassiveMin] = useState(passive ? String(range?.min ?? settings.passiveMin + (protocol === "ftps" ? 10 : 0)) : "");
  const [passiveMax, setPassiveMax] = useState(passive ? String(range?.max ?? settings.passiveMin + (protocol === "ftps" ? 19 : 9)) : "");
  const [check, setCheck] = useState<PortCheck | null>(null);
  const [checkError, setCheckError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [confirmation, setConfirmation] = useState<{ port: number; passiveRange?: { min: number; max: number }; clients: number } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const effectivePort = port === "" ? defaults[protocol] : Number(port);
  const validPort = port === "" || (/^\d+$/.test(port) && effectivePort >= 1 && effectivePort <= 65535);
  const validRange = !canEditPassive || (/^\d+$/.test(passiveMin) && /^\d+$/.test(passiveMax) &&
    Number(passiveMin) >= 1 && Number(passiveMax) <= 65535 && Number(passiveMin) <= Number(passiveMax));
  const valid = validPort && validRange;
  const query = `port=${effectivePort}${canEditPassive ? `&passiveMin=${Number(passiveMin)}&passiveMax=${Number(passiveMax)}` : ""}`;
  const checkMatches = check?.port === effectivePort && (!canEditPassive ||
    (check.passiveMin === Number(passiveMin) && check.passiveMax === Number(passiveMax)));

  useEffect(() => {
    setCheck(null);
    setCheckError("");
    if (!valid) return;
    const controller = new AbortController();
    let checking = false;
    const inspect = async () => {
      if (checking) return;
      checking = true;
      try {
        const result = await apiRequest<PortCheck>(`/api/v1/settings/${protocol}/port?${query}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setCheck(result); setCheckError(""); }
      } catch (error) {
        if (!controller.signal.aborted) { setCheck(null); setCheckError((error as Error).message); }
      } finally { checking = false; }
    };
    const delay = window.setTimeout(() => void inspect(), 300);
    const timer = window.setInterval(() => void inspect(), 5000);
    return () => { controller.abort(); window.clearTimeout(delay); window.clearInterval(timer); };
  }, [query, protocol, valid]);

  useEffect(() => {
    if (confirmation && !dialog.current?.open) dialog.current?.showModal();
    else if (!confirmation && dialog.current?.open) dialog.current.close();
  }, [confirmation]);

  const save = async (disconnectClients = false) => {
    if (saving || !valid || !check?.available || !checkMatches) return;
    const submittedPort = disconnectClients && confirmation ? confirmation.port : effectivePort;
    const submittedRange = disconnectClients && confirmation ? confirmation.passiveRange
      : canEditPassive ? { min: Number(passiveMin), max: Number(passiveMax) } : undefined;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const result = await apiRequest<ProtocolStatus>(`/api/v1/settings/${protocol}`, {
        method: "PUT", body: JSON.stringify({ port: submittedPort, disconnectClients, passiveRange: submittedRange }),
      });
      setConfirmation(null);
      await onSaved();
      if (result.enabled && (!result.running || result.discovery?.error)) {
        setError(result.error || result.discovery?.error || "The protocol could not start.");
      } else { setSaved(true); }
      setCheck(await apiRequest<PortCheck>(`/api/v1/settings/${protocol}/port?port=${submittedPort}${submittedRange ? `&passiveMin=${submittedRange.min}&passiveMax=${submittedRange.max}` : ""}`));
    } catch (error) {
      if (error instanceof ApiError && error.code === "CLIENTS_CONNECTED") {
        setConfirmation({ port: submittedPort, passiveRange: submittedRange, clients: error.activeClients || 1 });
      } else { setError((error as Error).message); }
      await onSaved();
    } finally { setSaving(false); }
  };

  const portUnavailable = check && checkMatches && !check.available;
  const failed = !valid || Boolean(checkError) || Boolean(portUnavailable) || status.conflict || Boolean(status.error) || Boolean(status.discovery?.error);
  const badge = !validPort ? "Invalid port"
    : !validRange ? "Invalid passive range"
    : checkError ? "Status unavailable"
    : portUnavailable ? (check.conflict ? "Port conflict" : "Unavailable")
    : status.conflict ? "Port conflict"
    : status.discovery?.error ? "Discovery unavailable"
    : !status.enabled ? "Unused"
    : status.running ? "Online" : "Stopped";
  const detail = !validPort ? "Choose a port between 1 and 65535."
    : !validRange ? "Choose passive ports between 1 and 65535, with the start no higher than the end."
    : checkError || (portUnavailable ? check.message : "") || status.error || status.discovery?.error
      || (!status.enabled ? "No folders use this service." : `TCP port ${status.port}`);

  return (
    <section>
      <PageHeader title={protocolNames[protocol]} description={descriptions[protocol]} />
      <form className="mt-8 max-w-3xl" onSubmit={event => { event.preventDefault(); void save(); }}>
        <Card>
          <CardContent className="pt-6">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-5">
              <div>
                <p className="text-sm font-medium">Connection status</p>
                <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
              </div>
              <span role="status" aria-live="polite" className={`inline-flex items-center gap-2 text-xs font-medium ${failed ? "text-red-600 dark:text-red-400" : status.running ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}>
                <span className={`size-2 rounded-full ${failed ? "bg-red-500" : status.running ? "bg-green-500" : "bg-muted-foreground"}`} />
                {badge}
              </span>
            </div>
            <div className="mt-5">
              <label htmlFor="protocol-port" className="text-sm font-medium">Port</label>
              <Input id="protocol-port" type="number" inputMode="numeric" min={1} max={65535} step={1}
                placeholder={String(defaults[protocol])} disabled={saving || Boolean(confirmation)}
                className="mt-1.5 block max-w-xs font-mono" value={port} aria-invalid={!validPort || Boolean(portUnavailable)}
                onChange={event => { setPort(event.target.value); setCheck(null); setSaved(false); setError(""); }} />
            </div>
            {passive && (
              <div className="mt-5 border-t pt-5">
                <fieldset className="min-w-0">
                  <legend className="text-sm font-medium">Passive Ports</legend>
                  <div className="mt-1.5 grid max-w-xs grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                    <div className="min-w-0">
                      <label htmlFor="passive-min" className="sr-only">Passive port start</label>
                      <Input id="passive-min" type="number" inputMode="numeric" min={1} max={65535} step={1} required placeholder="Start"
                        disabled={!canEditPassive || saving || Boolean(confirmation)} value={passiveMin} aria-invalid={!validRange || Boolean(portUnavailable)}
                        className="font-mono" aria-describedby="passive-help"
                        onChange={event => { setPassiveMin(event.target.value); setCheck(null); setSaved(false); setError(""); }} />
                    </div>
                    <span aria-hidden="true" className="text-muted-foreground">—</span>
                    <div className="min-w-0">
                      <label htmlFor="passive-max" className="sr-only">Passive port end</label>
                      <Input id="passive-max" type="number" inputMode="numeric" min={1} max={65535} step={1} required placeholder="End"
                        disabled={!canEditPassive || saving || Boolean(confirmation)} value={passiveMax} aria-invalid={!validRange || Boolean(portUnavailable)}
                        className="font-mono" aria-describedby="passive-help"
                        onChange={event => { setPassiveMax(event.target.value); setCheck(null); setSaved(false); setError(""); }} />
                    </div>
                  </div>
                </fieldset>
                <p id="passive-help" className="mt-3 text-xs leading-relaxed text-muted-foreground">
                  Used for directory listings and file transfers. Allow this TCP range through your firewall.
                  {validRange && ` Supports up to ${Number(passiveMax) - Number(passiveMin) + 1} simultaneous data transfers.`}
                </p>
                {!canEditPassive && <p className="mt-2 text-xs text-muted-foreground">Restart Transfarr to enable editing passive port ranges.</p>}
                {protocol === "ftps" && <p className="mt-2 text-xs text-muted-foreground">Choose implicit TLS in your FTP client.</p>}
              </div>
            )}
          </CardContent>
          <hr className="border-border" />
          <div className="flex flex-wrap items-center justify-end gap-3 px-5 py-4">
            {saved && <p role="status" className="mr-auto text-sm text-green-600 dark:text-green-400">Changes saved.</p>}
            {error && !confirmation && <p role="alert" className="mr-auto text-sm text-red-600 dark:text-red-400">{error}</p>}
            <Button type="submit" disabled={saving || Boolean(confirmation) || !valid || !check?.available || !checkMatches}>
              {saving && <LoaderCircle className="mr-2 size-4 animate-spin" />}
              Save changes
            </Button>
          </div>
        </Card>
      </form>
      <dialog ref={dialog} aria-labelledby="disconnect-title" aria-describedby="disconnect-description"
        className="m-auto w-[calc(100%-2.5rem)] max-w-md rounded-2xl border bg-background p-6 text-foreground shadow-2xl backdrop:bg-black/45"
        onCancel={event => { if (saving) event.preventDefault(); else setConfirmation(null); }}
        onClose={() => setConfirmation(null)}>
        <h2 id="disconnect-title" className="text-lg font-semibold">Disconnect connected clients?</h2>
        <p id="disconnect-description" className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {confirmation?.clients} {protocolNames[protocol]} {confirmation?.clients === 1 ? "client is" : "clients are"} connected.
          Saving will disconnect {confirmation?.clients === 1 ? "this client" : "these clients"} and interrupt any active transfers.
        </p>
        {error && <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="outline" autoFocus disabled={saving} onClick={() => setConfirmation(null)}>Cancel</Button>
          <Button type="button" disabled={saving || !check?.available || !checkMatches} onClick={() => void save(true)}>
            {saving && <LoaderCircle className="mr-2 size-4 animate-spin" />}
            Save and disconnect
          </Button>
        </div>
      </dialog>
    </section>
  );
}
