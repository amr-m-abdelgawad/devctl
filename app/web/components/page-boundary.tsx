import { Component, type ReactNode } from "react";
import { Button } from "./ui/button.tsx";

export class PageBoundary extends Component<{ route: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidUpdate(previous: Readonly<{ route: string; children: ReactNode }>) {
    if (this.state.failed && previous.route !== this.props.route) this.setState({ failed: false });
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex flex-col items-start gap-4 rounded-xl border p-6">
        <h2 className="text-lg font-semibold">This page couldn’t be displayed</h2>
        <p className="text-sm text-muted-foreground">Try again, or choose another section from the navigation.</p>
        <Button variant="outline" onClick={() => this.setState({ failed: false })}>
          Try again
        </Button>
      </div>
    );
  }
}
