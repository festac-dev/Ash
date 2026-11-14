import { Component } from "react";
import { Dialog } from "./Dialog.jsx";

export class PanelBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <Dialog title="View unavailable" onClose={this.props.onClose}>
        <p>Please reload to get the latest version.</p>
        <button className="button-secondary" onClick={() => location.reload()}>
          Reload
        </button>
      </Dialog>
    ) : (
      this.props.children
    );
  }
}
