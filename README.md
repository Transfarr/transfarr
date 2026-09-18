<p align="center">
  <a href="#getting-started"><img src="./frontend/public/logo.png" width="128" height="128" alt="Transfarr" /></a>
</p>
<h3 align="center">Transfarr</h3>
<p align="center">Share your files over SMB, FTP, FTPS &amp; SFTP — from one place.</p>

---

👋 **Welcome to Transfarr!** Transfarr includes everything you need to:

* Share folders using SMB (SMB2/3), FTP, FTPS, and SFTP.
* Create users and give them read-only or read/write access to each folder.
* Browse your filesystem and choose which protocols each folder uses.
* Configure ports and see whether services are online, unused, or have a port conflict.
* Inspect file protocol activity in **Debug → Logs**, including users, paths, client IPs, and results.

> 💡 All four protocols run in the same Node.js process. Transfarr manages its own users; it does not create Linux accounts or run separate file-sharing daemons.

# Screenshots

<img alt="Shared folders with protocols and user permissions" src="./screenshots/Folders.png">

<img alt="Edit a shared folder and configure access permissions" src="./screenshots/Folders → Edit Folder.png">

<img alt="FTPS connection settings and passive transfer ports" src="./screenshots/Settings → FTPS.png">

[View more screenshots »](./screenshots)

# Requirements

* Docker Engine with host networking (Docker Compose is optional).
* A directory containing the files you want to share, writable by the container's configured UID/GID.
* Port **3000** for the web interface, plus an available port for each sharing protocol you enable.

Linux supports Docker host networking directly. On [Docker Desktop](https://docs.docker.com/engine/network/drivers/host/), enable its host-networking feature. [OrbStack](https://docs.orbstack.dev/docker/network#host-networking) also supports host networking. For a native macOS run, see [Development](#development).

# Getting Started

The recommended way to install Transfarr is using [Containarr](https://containarr.com), created by the same author. To install it directly with Docker, follow the steps below.

Open a terminal or SSH session on your host device.

## 1. Install Docker

If you haven't installed Docker yet, install it on Linux by running:

```bash
curl -sSL https://get.docker.com | sh
sudo usermod -aG docker $(whoami)
exit
```

Then log in again.

## 2. Run Transfarr

Replace `192.168.1.10` with your server's reachable IP address or DNS name for passive FTP and FTPS connections.

```bash
docker run \
  --detach \
  --name=transfarr \
  --network=host \
  --volume "~/.transfarr:/data" \
  --volume "/path/to/your/shares:/mnt" \
  --restart unless-stopped \
  ghcr.io/transfarr/transfarr:latest
```

> 💡 Your settings, accounts, certificates, and SSH host key are saved in `~/.transfarr`.

<details>
<summary>Alternative: docker-compose.yml</summary>

Save the following as `docker-compose.yml`.

```yaml
services:
  transfarr:
    image: ghcr.io/transfarr/transfarr:latest
    container_name: transfarr
    restart: unless-stopped
    network_mode: host
    volumes:
      - ~/.transfarr:/data
      - /path/to/your/shares:/mnt
```

Then run:

```bash
docker compose up -d
```

</details>

## 3. Open a Browser

Open [http://localhost:3000](http://localhost:3000), or `http://<ip-of-your-host>:3000` if Transfarr runs on another device.

The web interface opens directly.

1. Open **Users** and create a file-sharing account with a username and password.
2. Open **Folders**, add a folder, and use the picker to select its path under `/mnt`.
3. Choose the users who can access it, their read-only or read/write permissions, and the protocols to enable. Check **Anonymous** to allow access without a password, with its own read-only or read/write permission.

File-sharing clients authenticate with the usernames and passwords created on the Users page. For folders with **Anonymous** enabled, choose anonymous/guest access in SMB clients, or use the username `anonymous` in FTP, FTPS, and SFTP clients (no password required). Anonymous clients see only folders explicitly granting anonymous access. Named users keep their own permissions.

> Transfarr does not have built-in authentication. You're expected to run it behind a reverse proxy, such as [Containarr](https://containarr.com), which does the authentication.

## 4. Connect Your Clients

| Protocol | Default TCP port | Connection |
| --- | --- | --- |
| SMB2/3 | `445` | `smb://<host>` or `\\<host>` to browse permitted shares |
| FTP | `21` | FTP with passive mode |
| FTPS | `990` | FTP with **implicit TLS** and passive mode |
| SFTP | `22` | SFTP with your sharing username and password |
| FTP passive data | `50000–50009` | Used for directory listings and transfers |
| FTPS passive data | `50010–50019` | Used for directory listings and transfers |

FTP, FTPS, and SFTP show a root directory containing the user's permitted shares. SMB lets users select a share or connect directly to `smb://<host>/<ShareName>`.

# Architecture

Transfarr runs the web interface and all sharing protocols inside one Node.js process.

```text
Browser → React web interface → Transfarr administration

File-sharing client → SMB / FTP / FTPS / SFTP → Shared folders
                     └─ One Node.js process ─┘
```

SMB uses an embedded Rust N-API module. FTP, FTPS, and SFTP use Node.js libraries. There is no separate SMB daemon, FTP daemon, or SSH server in the container.

# FAQ

**A port is already in use. Can I still use Transfarr?**

Yes. The web interface and other protocols remain available. Choose a free port in that protocol's Settings page, or stop the conflicting service and click **Save changes**. Changing to an occupied port leaves the existing listener unchanged. Host networking uses the configured ports directly, without Docker port mappings.

**Why can I log in to FTP but not list files?**

FTP uses a separate data connection for listings and transfers. Set `TRANSFARR_PUBLIC_HOST` to an address reachable by your client and allow the passive port range through any firewall. Transfarr keeps passive listeners open while the service is online and supports one simultaneous data transfer per port in each service’s configured range (ten per service by default).

**How do I connect to SMB from the same Mac running Transfarr?**

For a native macOS run, set the SMB port to **1445** and use `smb://127.0.0.1:1445`. Finder rejects same-Mac connections on ports 445 and 139.

The local runner also opens a port **445** compatibility listener for Apple's share-discovery client. It accepts only IPv4 loopback connections and forwards them to the same embedded SMB server. Conflicts appear in SMB Settings and the sidebar. If discovery is unavailable, use `smb://127.0.0.1:1445/<ShareName>` to connect directly. Set `TRANSFARR_SMB_DISCOVERY=false` to disable the compatibility listener.

**Are connections encrypted?**

Use **SFTP** or **FTPS** for encrypted file transfers. FTP is plaintext. FTPS creates a persistent self-signed certificate on first start; trust it in your client or supply your own certificate and key. SFTP keeps the same host key across restarts. Web administration has no built-in authentication; use your reverse proxy for HTTPS and access control.

**Who owns uploaded files?**

All protocols use the process UID/GID. With the default umask of `0022`, new files normally have mode `0644` and directories `0755`. Existing files retain their ownership and permissions. Transfarr does not switch Unix users or apply per-user `chmod`/`chown`; clients cannot change Unix ownership or mode. Host ACLs and setgid directories can affect filesystem inheritance.

**What happens when I change access or delete a shared folder?**

Editing users or shares disconnects active transfers so permission changes take effect. Clients can reconnect with their updated access. Removing a share from Transfarr does **not** delete its files. Folders without enabled protocols or any access grants are inaccessible.

See [CHANGELOG.md](./CHANGELOG.md) for changes.
