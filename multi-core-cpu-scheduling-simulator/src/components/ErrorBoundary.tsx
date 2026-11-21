import React from 'react';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      message: error?.message || 'An unexpected rendering error occurred.',
    };
  }

  handleReload = () => {
    this.setState({ hasError: false, message: '' });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6 text-white">
          <div className="liquid-glass max-w-md w-full p-6 text-center space-y-4">
            <h1 className="text-lg font-bold">Something went wrong</h1>
            <p className="text-xs text-white/70 leading-relaxed">{this.state.message}</p>
            <button
              type="button"
              onClick={this.handleReload}
              className="h-10 px-5 rounded-full bg-[#0A84FF] hover:bg-[#0A84FF]/90 text-xs font-semibold text-white cursor-pointer"
            >
              Reset Interface
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
