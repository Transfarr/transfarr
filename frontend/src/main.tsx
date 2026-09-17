import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { App } from "./app";
import "./index.css";

// Keep existing bookmarks working after switching to hash-based routing.
if (window.location.pathname !== "/" && !window.location.hash) {
  window.history.replaceState(null, "", `/#${window.location.pathname}${window.location.search}`);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
