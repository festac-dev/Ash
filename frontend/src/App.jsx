import LandingApp from "./LandingApp.jsx";
import WorkspaceApp from "./WorkspaceApp.jsx";

export default function App({ pathname = "/" }) {
  return ["/workspace", "/workspace/", "/workspace/controls", "/console"].includes(pathname) ? (
    <WorkspaceApp />
  ) : (
    <LandingApp />
  );
}
