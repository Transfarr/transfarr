export type ViewMode = "cards" | "table";
export type Protocol = "smb" | "ftp" | "ftps" | "sftp";
export type User = { id: string; username: string };
export type SharedFolder = {
  id: string;
  name: string;
  path: string;
  protocols: Protocol[];
  permissions: Record<string, "read" | "write">;
};
export type State = {
  users: User[];
  folders: SharedFolder[];
  root: string;
  protocols: Record<Protocol, ProtocolStatus>;
};
export const protocolNames: Record<Protocol, string> = {
  smb: "SMB",
  ftp: "FTP",
  ftps: "FTPS",
  sftp: "SFTP",
};

export type ProtocolStatus = {
  running: boolean;
  enabled: boolean;
  port: number;
  conflict: boolean;
  error?: string;
  discovery?: { port: number; running: boolean; conflict: boolean; error?: string };
};
export type Settings = {
  protocols: Record<Protocol, ProtocolStatus>;
  passiveMin: number;
  passiveRanges?: Record<"ftp" | "ftps", { min: number; max: number }>;
};
