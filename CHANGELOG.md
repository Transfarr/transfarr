# Next

* Fixed the SMB discovery integration test fixture to support activity logging and verify log draining during shutdown.
* Added Debug → Logs with persistent FTP, FTPS, SFTP, and SMB activity, users, paths, client IPs, results, search, filters, and auto-refresh.
* Added logo icons for Apple home-screen shortcuts, web app shortcuts, and browser favicons.
* Fixed FTP and FTPS creation of nested directories and missing-path listing replies for camera uploads; FTP error logs now include the command name.
* Changed navigation to hash-based URLs while preserving existing page bookmarks.
* Fixed blank settings pages when the updated frontend connects to a server that has not restarted yet.
* Added configurable FTP and FTPS passive port ranges with persistent settings, conflict checks, and confirmation before disconnecting clients.
* Changed configuration storage from JSON to SQLite using Sequelize, following Containarr. Existing JSON data is not imported.
* Removed the local runner's automatic Docker data import.

* Added per-folder Anonymous access with read-only or read/write permissions for SMB, FTP, FTPS, and SFTP.

* Removed web administration login; access control is handled by the reverse proxy. File-sharing authentication remains enabled.
* Changed protocol Settings to use one status indicator, default port placeholders, and an in-card save button.
* Added confirmation before settings changes disconnect connected clients.
* Fixed SFTP port changes waiting for clients with incomplete SSH handshakes.

* Added authenticated SMB share discovery, filtered by folder permissions, and local macOS Finder discovery compatibility.

* Added a native local runner that imports Docker accounts and keys, translates share paths, and keeps local configuration separate.
* Added green online and grey unused service indicators, with protocols stopped when no folders use them.
* Fixed FTP directory listing failures in desktop Docker host networking by keeping passive data ports open while online.
* Added protocol Settings pages with persistent ports, live availability checks, and sidebar conflict indicators.
* Changed Docker to host networking with standard SMB, FTP, FTPS, and SFTP ports while retaining the configured filesystem user.
* Removed the setup-token requirement; create the administration account with a username and password on first launch.
* Added Transfarr with Containarr's React interface, folder browser, and supplied logo.
* Added application users, shared folders, per-user read/write permissions, and protocol selection.
* Added in-process SMB2/3, FTP, FTPS, and SFTP servers with persistent administration.
* Added Docker deployment and multi-architecture GitHub Container Registry publishing.

# v0.1.0

* Added the initial Transfarr project.
