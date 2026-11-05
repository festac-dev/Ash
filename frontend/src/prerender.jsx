import { renderToString } from "react-dom/server";
import App from "./App.jsx";

// Build-time HTML is always public and disconnected. No workspace data is loaded.
export function render(pathname = "/") {
  return renderToString(<App pathname={pathname} />);
}
