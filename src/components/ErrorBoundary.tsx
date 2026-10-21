import { Component, type ErrorInfo, type ReactNode } from "react";
import { logError } from "@/lib/logger";
import { ErrorPanel } from "./ErrorPanel";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    logError("react", error.message, info.componentStack ?? error.stack);
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary] caught", error, info);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleReset = () => {
    this.setState({ error: null, componentStack: null });
  };

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full min-h-screen items-center justify-center bg-zinc-50 p-6 text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
        <ErrorPanel
          error={error}
          componentStack={componentStack}
          onReload={this.handleReload}
          onDismiss={this.handleReset}
        />
      </div>
    );
  }
}
