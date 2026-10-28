import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback: (reset: () => void) => ReactNode;
  onCatch?: () => void;
}

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    this.props.onCatch?.();
  }

  render(): ReactNode {
    if (this.state.failed) {
      return this.props.fallback(() => {
        this.setState({ failed: false });
      });
    }
    return this.props.children;
  }
}
