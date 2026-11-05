import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import "./styles.css";
import App from "./App.jsx";

// The globe has its own recovery boundary; API or GPU failure never hides navigation.
const root = document.getElementById("root");
if (root.hasChildNodes()) hydrateRoot(root, <App pathname={window.location.pathname} />);
else createRoot(root).render(<App pathname={window.location.pathname} />);
