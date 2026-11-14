import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import "./styles.css";
import App from "./App.jsx";

const root = document.getElementById("root");
if (root.hasChildNodes()) hydrateRoot(root, <App pathname={window.location.pathname} />);
else createRoot(root).render(<App pathname={window.location.pathname} />);
