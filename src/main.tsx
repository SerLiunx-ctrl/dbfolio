import React from "react";
import ReactDOM from "react-dom/client";
import "./monaco";
import "./styles.css";
import "./compact.css";
import "./motion.css";
import App from "./App";

import { installBrowserGuards } from "./app/browserGuards";
installBrowserGuards();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
