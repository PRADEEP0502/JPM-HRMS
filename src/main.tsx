import React, { Component, ErrorInfo, ReactNode } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('App ErrorBoundary caught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '40px', fontFamily: 'system-ui, sans-serif', maxWidth: '600px', margin: '40px auto', background: '#fff', borderRadius: '12px', boxShadow: '0 4px 20px rgba(0,0,0,0.1)', color: '#1e293b' }}>
          <h2 style={{ color: '#ef4444', marginBottom: '12px' }}>Dashboard Error</h2>
          <p style={{ color: '#64748b', marginBottom: '20px' }}>{this.state.error?.message || 'An unexpected error occurred.'}</p>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={() => { localStorage.clear(); window.location.reload(); }}
              style={{ background: '#0284c7', color: '#fff', border: 'none', padding: '10px 18px', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}
            >
              Clear Session & Reload
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{ background: '#f1f5f9', color: '#334155', border: '1px solid #cbd5e1', padding: '10px 18px', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
